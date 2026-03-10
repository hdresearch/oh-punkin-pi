/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	now,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@punkin-pi/ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types.js";

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		let steeringAfterTools: AgentMessage[] | null = null;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// Check for visible content (text/thinking that user would see)
				// Tool calls still need turn_end for proper recording
				const hasVisibleContent = message.content.some(
					(c) => c.type === "text" || c.type === "thinking",
				);
				const hasToolCalls = message.content.some((c) => c.type === "toolCall");

				// Skip turn_end for aborted turns with no visible content and no tool calls
				// Error turns with visible content or tool calls still get turn_end (diagnostic value)
				if (
					message.stopReason === "aborted" &&
					!hasVisibleContent &&
					!hasToolCalls
				) {
					// No turn_end emitted — empty aborted turn silently dropped
				} else {
					stream.push({ type: "turn_end", message, toolResults: [] });
				}

				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const toolExecution = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
				);
				toolResults.push(...toolExecution.toolResults);
				steeringAfterTools = toolExecution.steeringMessages ?? null;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			// Get steering messages after turn completes
			if (steeringAfterTools && steeringAfterTools.length > 0) {
				pendingMessages = steeringAfterTools;
				steeringAfterTools = null;
			} else {
				pendingMessages = (await config.getSteeringMessages?.()) || [];
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

// Default empty response retry settings
const DEFAULT_MAX_EMPTY_RETRIES = 3;
const DEFAULT_MAX_EMPTY_RETRY_TIME_MS = 30000;
const EMPTY_RETRY_JITTER_MS = 1000; // max random delay before retry
const EMPTY_RETRY_VIRTUAL_TEXT = "[virtual-empty-assistant-retry]";
const USE_VIRTUAL_EMPTY_RETRY_MESSAGE = process.env.PUNKIN_EMPTY_RETRY_VIRTUAL === "1";
const DEBUG_EMPTY_RETRY = process.env.PUNKIN_DEBUG_EMPTY_RETRY === "1";

/** Sleep with optional abort signal */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		}, { once: true });
	});
}

function isEmptyAssistantRetryMessage(message: AgentMessage): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		message.content.length === 0 &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error"
	);
}

function collapseTrailingEmptyAssistantRetries(messages: AgentMessage[], keepOne: boolean): void {
	let idx = messages.length - 1;
	while (idx >= 0 && isEmptyAssistantRetryMessage(messages[idx])) {
		idx--;
	}
	const trailingStart = idx + 1;
	const trailingCount = messages.length - trailingStart;
	if (trailingCount <= 0) return;
	if (keepOne) {
		if (trailingCount > 1) {
			messages.splice(trailingStart, trailingCount - 1);
		}
		return;
	}
	messages.splice(trailingStart, trailingCount);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 * Retries if model returns empty response (happens occasionally with Anthropic/OpenRouter).
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
	emptyRetryCount: number = 0,
	emptyRetryStartMs?: number,
	forcedReconnectAttempted: boolean = false,
	emptyRetryEpisodeId?: string,
): Promise<AssistantMessage> {
	const maxRetries = config.maxEmptyRetries ?? DEFAULT_MAX_EMPTY_RETRIES;
	const maxTimeMs = config.maxEmptyRetryTimeMs ?? DEFAULT_MAX_EMPTY_RETRY_TIME_MS;
	const retryStartMs = emptyRetryStartMs ?? Date.now();
	const retryEpisodeId = emptyRetryEpisodeId ?? `${retryStartMs}-${Math.random().toString(36).slice(2, 8)}`;
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Get bracket prefill — open tag for LLM to see, bracketId stored on message for render-time wrapping
	// const prefill = config.getPrefill?.();
	const prefill={} ;

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const submittedAt = now();
	const submittedMs = Date.now();
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	let firstContentMs: number | undefined;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "thinking_start":
				if (firstContentMs === undefined) {
					firstContentMs = Date.now();
				}
			// falls through
			case "text_delta":
			case "text_end":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					stream.push({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				let finalMessage = await response.result();

				// Attach timing metadata
				finalMessage = {
					...finalMessage,
					submittedAt,
					...(firstContentMs !== undefined ? { ttftMs: firstContentMs - submittedMs } : {}),
					...{}
				};

				// Check for empty response (model returned no content) - this is NEVER valid
				// This happens occasionally with Anthropic/OpenRouter after tool results
				const isEmpty = finalMessage.content.length === 0 && finalMessage.stopReason !== "aborted" && finalMessage.stopReason !== "error";
				if (isEmpty && !signal?.aborted) {
					const includeEmptyInNextRequest = config.includeEmptyMsgInNextRequest ?? true;

					const retryReplayMessage: AgentMessage =
						USE_VIRTUAL_EMPTY_RETRY_MESSAGE && includeEmptyInNextRequest
							? {
									role: "user",
									content: [{ type: "text", text: EMPTY_RETRY_VIRTUAL_TEXT }],
									timestamp: now(),
									endTimestamp: now(),
							  }
							: finalMessage;

					if (addedPartial) {
						if (includeEmptyInNextRequest) {
							context.messages[context.messages.length - 1] = retryReplayMessage;
						} else {
							context.messages.pop();
						}
					} else if (includeEmptyInNextRequest) {
						context.messages.push(retryReplayMessage);
					}
					if (USE_VIRTUAL_EMPTY_RETRY_MESSAGE && includeEmptyInNextRequest) {
						// Virtual mode replaces empty assistant replay with a faux user message.
						// Ensure no trailing empty assistant retry placeholders remain.
						collapseTrailingEmptyAssistantRetries(context.messages, false);
					} else {
						// Keep trailing empty assistant retries canonical:
						// either exactly one (include=true) or none (include=false).
						collapseTrailingEmptyAssistantRetries(context.messages, includeEmptyInNextRequest);
					}

					const elapsedMs = Date.now() - retryStartMs;
					const withinTimeLimit = elapsedMs < maxTimeMs;
					const withinRetryLimit = emptyRetryCount < maxRetries;

					if (DEBUG_EMPTY_RETRY) {
						console.error(
							`[EMPTY-RETRY] id=${retryEpisodeId} model=${config.model.provider}/${config.model.id} ` +
								`attempt=${emptyRetryCount + 1}/${maxRetries + 1} elapsedMs=${elapsedMs} ` +
								`maxTimeMs=${maxTimeMs} includeEmptyInNextRequest=${includeEmptyInNextRequest} ` +
								`addedPartial=${addedPartial}`,
						);
					}

					if (withinRetryLimit && withinTimeLimit) {
						// Add random jitter before retry
						const jitter = Math.random() * EMPTY_RETRY_JITTER_MS;
						try {
							await sleepWithSignal(jitter, signal);
						} catch {
							// Aborted during sleep
						}
						// Retry
						return streamAssistantResponse(
							context,
							config,
							signal,
							stream,
							streamFn,
							emptyRetryCount + 1,
							retryStartMs,
							forcedReconnectAttempted,
							retryEpisodeId,
						);
					} else if (!forcedReconnectAttempted) {
						const reconnectToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
						const reconnectConfig: AgentLoopConfig = {
							...config,
							headers: {
								...(config.headers ?? {}),
								"x-punkin-force-reconnect": reconnectToken,
								Connection: "close",
							},
						};
						if (DEBUG_EMPTY_RETRY) {
							console.error(
								`[EMPTY-RETRY-FORCE-RECONNECT] id=${retryEpisodeId} model=${config.model.provider}/${config.model.id} ` +
									`token=${reconnectToken}`,
							);
						}
						return streamAssistantResponse(context, reconnectConfig, signal, stream, streamFn, 0, undefined, true, retryEpisodeId);
					} else {
						if (DEBUG_EMPTY_RETRY) {
							console.error(
								`[EMPTY-RETRY-EXHAUSTED] id=${retryEpisodeId} model=${config.model.provider}/${config.model.id} ` +
									`retries=${emptyRetryCount + 1} elapsedMs=${elapsedMs} maxTimeMs=${maxTimeMs}`,
							);
						}
						// Exhausted retries - return as error
						finalMessage = {
							...finalMessage,
							stopReason: "error",
							errorMessage:
								`Model returned empty response after ${emptyRetryCount + 1} retries (${elapsedMs}ms). ` +
								`maxRetries=${maxRetries}, maxEmptyRetryTimeMs=${maxTimeMs}, includeEmptyMsgInNextRequest=${
									config.includeEmptyMsgInNextRequest ?? true
								}, forcedReconnectAttempted=${forcedReconnectAttempted}`,
						};
					}
				}

				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const results: ToolResultMessage[] = [];
	let steeringMessages: AgentMessage[] | undefined;

	for (let index = 0; index < toolCalls.length; index++) {
		const toolCall = toolCalls[index];
		const tool = tools?.find((t) => t.name === toolCall.name);

		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let result: AgentToolResult<any>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			const validatedArgs = validateToolArguments(tool, toolCall);

			result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
				stream.push({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args: toolCall.arguments,
					partialResult,
				});
			});
		} catch (e) {
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: now(),
			endTimestamp: now(),
		};

		results.push(toolResultMessage);
		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });

		// Check for steering messages - skip remaining tools if user interrupted
		if (getSteeringMessages) {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				const remainingCalls = toolCalls.slice(index + 1);
				for (const skipped of remainingCalls) {
					results.push(skipToolCall(skipped, stream));
				}
				break;
			}
		}
	}

	return { toolResults: results, steeringMessages };
}

function skipToolCall(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): ToolResultMessage {
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: now(),
		endTimestamp: now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}
