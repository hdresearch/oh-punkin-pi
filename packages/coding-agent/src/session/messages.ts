/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	BracketId,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import {
	closeSquiggleBracket,
	generateSystemBracketId,
	generateUserBracketId,
	openSquiggleBracket,
	type ToolResultWrapParams,
	type WrapParams,
	wrapSystem,
	wrapToolResult,
	wrapUser,
} from "@oh-my-pi/pi-ai/role-boundary";
import { renderPromptTemplate } from "../config/prompt-templates";
import branchSummaryContextPrompt from "../prompts/compaction/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "../prompts/compaction/compaction-summary-context.md" with { type: "text" };
import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
}

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

/**
 * Convert ThinkingContent blocks in an assistant message to squiggle-wrapped
 * TextContent blocks so the model can read its own prior reasoning.
 *
 * Thinking blocks are opaque to the model — the API preserves them for
 * continuity (signatures, replay) but the model cannot reference their content.
 * This transform emits a readable squiggle-formatted text copy alongside each
 * thinking block, giving the model access to its own chain-of-thought.
 *
 * The original ThinkingContent blocks are preserved for API/signature correctness.
 */
function reifyThinkingAsSquiggle(msg: AssistantMessage): AssistantMessage {
	const hasThinking = msg.content.some(b => b.type === "thinking" && b.thinking.trim() !== "");
	if (!hasThinking) return msg;

	const content: AssistantMessage["content"] = msg.content.flatMap(block => {
		if (block.type !== "thinking" || block.thinking.trim() === "") return [block];

		// Emit squiggle-wrapped text copy, then the original thinking block
		const { marker: openMarker, bracketId } = openSquiggleBracket();
		const closeMarker = closeSquiggleBracket(bracketId);
		const squiggleText: TextContent = {
			type: "text",
			text: `${openMarker}\n${block.thinking}\n${closeMarker}`,
		};
		return [squiggleText, block];
	});

	return { ...msg, content };
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
	bracketId?: BracketId;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as the agent's Python tool.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
	bracketId?: BracketId;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
	bracketId?: BracketId;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
	bracketId?: BracketId;
}

/**
 * Turn boundary messages — injected around completed assistant turns
 * to provide structural demarcation in conversation history.
 */
export interface TurnStartMessage {
	role: "turnStart";
	turn: number;
	sigil: string;
	nonce: string;
	timestamp: number;
	delta?: string;
}

export interface TurnEndMessage {
	role: "turnEnd";
	turn: number;
	sigil: string;
	nonce: string;
	hash: string;
	timestamp: number;
	tokenCount?: number;
	durationMs: number;
	isEmpty?: boolean;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
	bracketId?: BracketId;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	timestamp: number;
	bracketId?: BracketId;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
	}>;
	timestamp: number;
	bracketId?: BracketId;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@oh-my-pi/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
		turnStart: TurnStartMessage;
		turnEnd: TurnEndMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
		bracketId: generateSystemBracketId(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		timestamp: new Date(timestamp).getTime(),
		bracketId: generateSystemBracketId(),
	};
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}

		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely.
	// After rehydration it belongs to a previous live provider connection and
	// replaying it on a warmed session causes 401 rejections from GitHub Copilot.
	// User/developer payloads are preserved separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
		bracketId: generateUserBracketId(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	let turnIndex = 0;
	let prevAssistantTimestamp: number | null = null;

	for (const m of messages) {
		let converted: Message | undefined;

		switch (m.role) {
			case "bashExecution":
				if (m.excludeFromContext) {
					converted = undefined;
				} else {
					turnIndex++;
					const text = bashExecutionToText(m);
					const params: WrapParams = {
						timestamp: prevAssistantTimestamp ?? m.timestamp,
						endTimestamp: m.timestamp,
						turn: turnIndex,
					};
					converted = {
						role: "user",
						content: [{ type: "text", text: wrapUser(text, params, m.bracketId) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				}
				break;
			case "pythonExecution":
				if (m.excludeFromContext) {
					converted = undefined;
				} else {
					turnIndex++;
					const text = pythonExecutionToText(m);
					const params: WrapParams = {
						timestamp: prevAssistantTimestamp ?? m.timestamp,
						endTimestamp: m.timestamp,
						turn: turnIndex,
					};
					converted = {
						role: "user",
						content: [{ type: "text", text: wrapUser(text, params, m.bracketId) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				}
				break;
			case "custom":
			case "hookMessage": {
				turnIndex++;
				const rawContent =
					typeof m.content === "string"
						? m.content
						: m.content.map(c => (c.type === "text" ? c.text : "")).join("");
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				const wrappedText = wrapUser(rawContent, params, m.bracketId);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: wrappedText }];
				if (typeof m.content !== "string") {
					for (const c of m.content) {
						if (c.type === "image") content.push(c);
					}
				}
				converted = {
					role: "user",
					content,
					attribution: m.attribution,
					timestamp: m.timestamp,
				};
				break;
			}
			case "branchSummary": {
				turnIndex++;
				const text = renderPromptTemplate(BRANCH_SUMMARY_TEMPLATE, { summary: m.summary });
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				converted = {
					role: "user",
					content: [{ type: "text", text: wrapSystem(text, params, m.bracketId) }],
					attribution: "agent",
					timestamp: m.timestamp,
				};
				break;
			}
			case "compactionSummary": {
				turnIndex++;
				const text = renderPromptTemplate(COMPACTION_SUMMARY_TEMPLATE, { summary: m.summary });
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				converted = {
					role: "user",
					content: [{ type: "text", text: wrapSystem(text, params, m.bracketId) }],
					attribution: "agent",
					providerPayload: m.providerPayload,
					timestamp: m.timestamp,
				};
				break;
			}
			case "fileMention": {
				turnIndex++;
				const fileContents = m.files
					.map(file => {
						const inner = file.content ? `\n${file.content}\n` : "\n";
						return `<file path="${file.path}">${inner}</file>`;
					})
					.join("\n\n");
				const text = `<system-reminder>\n${fileContents}\n</system-reminder>`;
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: wrapSystem(text, params, m.bracketId) },
				];
				for (const file of m.files) {
					if (file.image) content.push(file.image);
				}
				converted = {
					role: "user",
					content,
					attribution: "user",
					timestamp: m.timestamp,
				};
				break;
			}
			case "user": {
				turnIndex++;
				const rawContent =
					typeof m.content === "string"
						? m.content
						: m.content.map(c => (c.type === "text" ? c.text : "")).join("");
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				const wrappedText = wrapUser(rawContent, params, m.bracketId);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: wrappedText }];
				if (typeof m.content !== "string") {
					for (const c of m.content) {
						if (c.type === "image") content.push(c);
					}
				}
				converted = {
					...m,
					content,
					attribution: m.attribution ?? "user",
					providerPayload: m.providerPayload,
					timestamp: m.timestamp,
					synthetic: (m as UserMessage).synthetic,
				};
				break;
			}
			case "developer":
				converted = { ...m, attribution: m.attribution ?? "agent" };
				break;
			case "assistant":
				prevAssistantTimestamp = m.timestamp;
				converted = reifyThinkingAsSquiggle(m as AssistantMessage);
				break;
			case "toolResult": {
				const trm = m as ToolResultMessage;
				const prunedContent = getPrunedToolResultContent(trm);
				const textParts = prunedContent.filter((c): c is TextContent => c.type === "text");
				const imageParts = prunedContent.filter((c): c is ImageContent => c.type === "image");
				const rawText = textParts.map(t => t.text).join("\n");
				const trParams: ToolResultWrapParams = {
					timestamp: prevAssistantTimestamp ?? trm.timestamp,
					endTimestamp: trm.timestamp,
					turn: turnIndex,
					toolName: trm.toolName,
				};
				const wrappedText = rawText ? wrapToolResult(rawText, trParams, trm.bracketId) : "";
				const content: (TextContent | ImageContent)[] = [];
				if (wrappedText) content.push({ type: "text", text: wrappedText });
				content.push(...imageParts);
				converted = {
					...trm,
					content: content.length > 0 ? content : prunedContent,
					attribution: trm.attribution ?? "agent",
				};
				break;
			}
			case "turnStart":
			case "turnEnd":
				// Turn boundaries are persisted and rendered in UI but not sent to the model yet.
				// Wire format TBD — developer role is wrong (collapses to user on Anthropic/Google,
				// means "trusted instruction" on OpenAI). See role_boundary_design doc.
				converted = undefined;
				break;
			default: {
				const _exhaustiveCheck: never = m;
				converted = undefined;
			}
		}

		if (converted !== undefined) {
			result.push(converted);
		}
	}

	return result;
}
