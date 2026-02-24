import type { Timestamp } from "@punkin-pi/ai";
/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@punkin-pi/agent-core";
import type { ImageContent, Message, TextContent } from "@punkin-pi/ai";
import { wrapUser, wrapAssistant, type WrapParams } from "@punkin-pi/ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

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
	fullOutputPath?: string;
	timestamp: Timestamp;
	endTimestamp: Timestamp;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: Timestamp;
	endTimestamp: Timestamp;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: Timestamp;
	endTimestamp: Timestamp;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: Timestamp;
	endTimestamp: Timestamp;
}

// Extend CustomAgentMessages via declaration merging
declare module "@punkin-pi/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
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
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: timestamp as Timestamp,
		endTimestamp: timestamp as Timestamp,
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: timestamp as Timestamp,
		endTimestamp: timestamp as Timestamp,
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: timestamp as Timestamp,
		endTimestamp: timestamp as Timestamp,
	};
}

/**
 * Compute human-readable delta between two timestamps.
 */
function computeDelta(prevEndTs: Timestamp | undefined, currentTs: Timestamp): string | undefined {
	if (!prevEndTs) return undefined;
	const deltaMs = new Date(currentTs).getTime() - new Date(prevEndTs).getTime();
	if (deltaMs < 1000) return undefined;
	if (deltaMs < 60000) return `${Math.round(deltaMs / 1000)}s`;
	if (deltaMs < 3600000) return `${Math.round(deltaMs / 60000)}m`;
	if (deltaMs < 86400000) return `${Math.round(deltaMs / 3600000)}h`;
	return `${Math.round(deltaMs / 86400000)}d`;
}

/**
 * Extract all text from content array.
 */
function extractText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
}

/**
 * Check if role increments turn (user-like messages).
 */
function isTurnIncrementing(role: string): boolean {
	return role === "user" || role === "bashExecution" || role === "custom" || 
	       role === "branchSummary" || role === "compactionSummary";
}

/**
 * Convert a single message to its raw text for wrapping.
 */
function messageToRawText(m: AgentMessage): string | null {
	switch (m.role) {
		case "bashExecution":
			return m.excludeFromContext ? null : bashExecutionToText(m);
		case "custom":
			return extractText(m.content);
		case "branchSummary":
			return BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX;
		case "compactionSummary":
			return COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX;
		case "user":
			return extractText(m.content);
		case "assistant": {
			// Always return content for wrapping - even tool-only turns get boundary markers
			const thinking = m.content.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking").map((c) => c.thinking);
			const text = m.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);
			const combined = [...thinking, ...text].join("\n");
			// Return empty string (not null) so wrapper is always added
			return combined || "";
		}
		case "toolResult":
			return null; // Don't wrap tool results
		default:
			return null;
	}
}

/**
 * Transform AgentMessages to LLM-compatible Messages with role boundary wrapping.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	let turn = 0;
	let prevEndTs: Timestamp | undefined;

	for (const m of messages) {
		// Skip excluded messages
		if (m.role === "bashExecution" && m.excludeFromContext) continue;

		// Get timestamps
		const ts = "timestamp" in m ? m.timestamp : undefined;
		const endTs = "endTimestamp" in m ? m.endTimestamp : ts;

		// Increment turn BEFORE building params (so this message gets correct turn number)
		if (isTurnIncrementing(m.role)) turn++;

		// Build wrap params
		const delta = ts && prevEndTs ? computeDelta(prevEndTs, ts) : undefined;
		const params: WrapParams | undefined = ts && endTs ? { timestamp: ts, endTimestamp: endTs, turn, delta } : undefined;

		// Update for next iteration
		if (endTs) prevEndTs = endTs;

		// Get raw text and wrap it
		const rawText = messageToRawText(m);
		const isUser = m.role !== "assistant" && m.role !== "toolResult";
		// Use explicit null check - empty string should still be wrapped
		const wrapped = rawText !== null && params 
			? (isUser ? wrapUser(rawText, params) : wrapAssistant(rawText, params))
			: rawText;

		// Build output message
		switch (m.role) {
			case "bashExecution":
			case "custom":
			case "branchSummary":
			case "compactionSummary":
				result.push({
					role: "user",
					content: [{ type: "text", text: wrapped! }],
					timestamp: m.timestamp,
					endTimestamp: m.endTimestamp,
				});
				break;

			case "user": {
				// Preserve images, replace text with single wrapped block
				const hasImages = Array.isArray(m.content) && m.content.some((c) => c.type === "image");
				if (hasImages) {
					const images = (m.content as (TextContent | ImageContent)[]).filter((c) => c.type === "image");
					result.push({
						...m,
						content: [{ type: "text", text: wrapped! }, ...images],
					});
				} else {
					result.push({ ...m, content: wrapped! });
				}
				break;
			}

			case "toolResult":
				result.push(m);
				break;

			case "assistant": {
				// Replace all text/thinking with single wrapped text block, keep toolCalls
				const toolCalls = m.content.filter((c) => c.type === "toolCall");
				const newContent = wrapped 
					? [{ type: "text" as const, text: wrapped }, ...toolCalls]
					: [...m.content.map((c) => c.type === "thinking" ? { type: "thinking" as const, thinking: c.thinking } : c)];
				result.push({ ...m, content: newContent });
				break;
			}
		}
	}

	return result;
}
