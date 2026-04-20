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
	generateSystemBracketIdDeterministic,
	generateToolResultBracketIdDeterministic,
	generateUserBracketId,
	generateUserBracketIdDeterministic,
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
// Static squiggle markers for thinking blocks - no nonce needed since these are
// model output (pseudo tool calls), not input. Keeping them static avoids cache busting.
const SQUIGGLE_OPEN = "<squiggle>";
const SQUIGGLE_CLOSE = "</squiggle>";

function reifyThinkingAsSquiggle(msg: AssistantMessage): AssistantMessage {
	const hasThinking = msg.content.some(b => b.type === "thinking" && b.thinking.trim() !== "");
	if (!hasThinking) return msg;

	const content: AssistantMessage["content"] = msg.content.flatMap(block => {
		if (block.type !== "thinking" || block.thinking.trim() === "") return [block];

		const squiggleText: TextContent = {
			type: "text",
			text: `${SQUIGGLE_OPEN}\n${block.thinking}\n${SQUIGGLE_CLOSE}`,
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
	bracketId: BracketId;
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
	bracketId: BracketId;
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
		// Deterministic bracketId keyed on entry identity — stable across session reloads.
		// branchSummary entries are reconstructed from the session file on every buildSessionContext(),
		// so random generation here would cache-bust every API call.
		bracketId: generateSystemBracketIdDeterministic(`branchSummary:${fromId}:${timestamp}`),
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
		// Deterministic bracketId keyed on entry identity — stable across session reloads.
		// compactionSummary entries are reconstructed from the session file on every buildSessionContext(),
		// so random generation here would cache-bust every API call.
		bracketId: generateSystemBracketIdDeterministic(`compactionSummary:${timestamp}`),
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
	bracketId?: BracketId,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
		bracketId: bracketId ?? generateUserBracketId(),
	};
}

// =============================================================================
// Deterministic bracketId assignment
// =============================================================================

/**
 * Content key for deterministic bracketId generation.
 * Must be unique per message — uses role + timestamp + turnIndex + full body.
 * SHA3 inside the generators handles the heavy lifting; we just need a
 * collision-free seed string per message.
 */
function bracketIdSeed(m: AgentMessage, turnIndex: number): string {
	const role = m.role;
	const ts = (m as { timestamp?: number }).timestamp ?? 0;
	// Full body discriminator — every message type contributes its content
	let body: string;
	switch (role) {
		case "toolResult":
			body = (m as ToolResultMessage).toolCallId;
			break;
		case "bashExecution":
			body = `${(m as BashExecutionMessage).command}:${(m as BashExecutionMessage).output}`;
			break;
		case "pythonExecution":
			body = `${(m as PythonExecutionMessage).code}:${(m as PythonExecutionMessage).output}`;
			break;
		case "user": {
			const c = (m as UserMessage).content;
			body = typeof c === "string" ? c : c.map(b => (b.type === "text" ? b.text : b.type)).join("\n");
			break;
		}
		case "custom":
		case "hookMessage": {
			const cm = m as CustomMessage;
			body =
				cm.customType +
				":" +
				(typeof cm.content === "string"
					? cm.content
					: cm.content.map(b => (b.type === "text" ? b.text : b.type)).join("\n"));
			break;
		}
		case "fileMention":
			body = (m as FileMentionMessage).files.map(f => `${f.path}:${f.content ?? ""}`).join("\n");
			break;
		case "branchSummary":
			body = (m as BranchSummaryMessage).summary;
			break;
		case "compactionSummary":
			body = (m as CompactionSummaryMessage).summary;
			break;
		default:
			body = JSON.stringify(m);
			break;
	}
	return `${role}:${ts}:${turnIndex}:${body}`;
}

/**
 * Ensure a user-role message has a bracketId. Assigns deterministically from
 * message content if missing, so repeated calls produce the same result.
 */
// Messages created after this date MUST have bracketId set at creation time.
// Missing bracketId after this cutoff indicates a bug in message construction.
// 2026-04-06T14:00:00Z (10:00 AM EDT)
const BRACKET_ID_REQUIRED_AFTER_MS = 1775656800000;

function warnMissingBracketId(role: string, timestamp: number): void {
	if (timestamp > BRACKET_ID_REQUIRED_AFTER_MS) {
		const msg = `Missing bracketId on ${role} message (ts=${timestamp}). Messages after 2026-04-06 must have bracketId set at creation. Falling back to deterministic generation.`;
		// Hard warning in dev, logged in prod — surfaces the bug without crashing inference
		if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
			console.error(msg);
		}
	}
}

function ensureUserBracketId(
	m: { bracketId?: BracketId; timestamp: number; role: string },
	turnIndex: number,
): BracketId {
	if (m.bracketId) return m.bracketId;
	warnMissingBracketId(m.role, m.timestamp);
	const id = generateUserBracketIdDeterministic(bracketIdSeed(m as AgentMessage, turnIndex));
	(m as { bracketId?: BracketId }).bracketId = id;
	return id;
}

/**
 * Ensure a tool result message has a bracketId. Assigns deterministically if missing.
 */
function ensureToolResultBracketId(m: ToolResultMessage, turnIndex: number): BracketId {
	if (m.bracketId) return m.bracketId;
	warnMissingBracketId(m.role, m.timestamp);
	const id = generateToolResultBracketIdDeterministic(bracketIdSeed(m, turnIndex));
	(m as { bracketId?: BracketId }).bracketId = id;
	return id;
}

// =============================================================================
// Cache key — stable across structuredClone since it's derived from message body
// =============================================================================

/** Cache key for a single message — content-derived, stable across clones. */
function messageCacheKey(m: AgentMessage): string {
	const role = m.role;
	const ts = (m as { timestamp?: number }).timestamp ?? 0;
	// toolResult can be pruned after initial render
	const pruned = role === "toolResult" ? ((m as ToolResultMessage).prunedAt ?? "") : "";
	// bashExecution/pythonExecution can be excluded mid-session
	const excluded =
		(role === "bashExecution" || role === "pythonExecution") &&
		(m as { excludeFromContext?: boolean }).excludeFromContext
			? "x"
			: "";
	return `${role}:${ts}:${pruned}:${excluded}`;
}

// =============================================================================
// Fold state + per-message conversion
// =============================================================================

interface FoldState {
	turnIndex: number;
	prevAssistantTimestamp: number | null;
}

interface ConvertOneResult {
	output: Message | undefined;
	state: FoldState;
}

/** Convert a single AgentMessage given the current fold state. Returns output + updated state. */
function convertOneMessage(m: AgentMessage, s: FoldState): ConvertOneResult {
	let { turnIndex, prevAssistantTimestamp } = s;
	let converted: Message | undefined;

	switch (m.role) {
		case "bashExecution":
			if (m.excludeFromContext) {
				converted = undefined;
			} else {
				turnIndex++;
				const bracketId = ensureUserBracketId(m, turnIndex);
				const text = bashExecutionToText(m);
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				converted = {
					role: "user",
					content: [{ type: "text", text: wrapUser(text, params, bracketId) }],
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
				const bracketId = ensureUserBracketId(m, turnIndex);
				const text = pythonExecutionToText(m);
				const params: WrapParams = {
					timestamp: prevAssistantTimestamp ?? m.timestamp,
					endTimestamp: m.timestamp,
					turn: turnIndex,
				};
				converted = {
					role: "user",
					content: [{ type: "text", text: wrapUser(text, params, bracketId) }],
					attribution: "user",
					timestamp: m.timestamp,
				};
			}
			break;
		case "custom":
		case "hookMessage": {
			turnIndex++;
			const bracketId = ensureUserBracketId(m, turnIndex);
			const rawContent =
				typeof m.content === "string" ? m.content : m.content.map(c => (c.type === "text" ? c.text : "")).join("");
			const params: WrapParams = {
				timestamp: prevAssistantTimestamp ?? m.timestamp,
				endTimestamp: m.timestamp,
				turn: turnIndex,
			};
			const wrappedText = wrapUser(rawContent, params, bracketId);
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
				content: [{ type: "text" as const, text: wrapSystem(text, params, m.bracketId) }],
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
			const bracketId = ensureUserBracketId(m, turnIndex);
			const rawContent =
				typeof m.content === "string" ? m.content : m.content.map(c => (c.type === "text" ? c.text : "")).join("");
			const params: WrapParams = {
				timestamp: prevAssistantTimestamp ?? m.timestamp,
				endTimestamp: m.timestamp,
				turn: turnIndex,
			};
			const wrappedText = wrapUser(rawContent, params, bracketId);
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
			const bracketId = ensureToolResultBracketId(trm, turnIndex);
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
			const wrappedText = rawText ? wrapToolResult(rawText, trParams, bracketId) : "";
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
			converted = undefined;
			break;
		default: {
			const _exhaustiveCheck: never = m;
			converted = undefined;
		}
	}

	return { output: converted, state: { turnIndex, prevAssistantTimestamp } };
}

// =============================================================================
// Cached converter
// =============================================================================

interface ConvertCacheEntry {
	key: string;
	/** Fold state AFTER processing this message. */
	postState: FoldState;
	output: Message | undefined;
}

/**
 * Cached converter that avoids re-rendering unchanged message prefixes.
 *
 * The fold state (turnIndex, prevAssistantTimestamp) propagates sequentially,
 * so a cache miss at position N invalidates everything from N onward.
 */
export class CachedMessageConverter {
	#cache: ConvertCacheEntry[] = [];

	convert(messages: AgentMessage[]): Message[] {
		const result: Message[] = [];
		let state: FoldState = { turnIndex: 0, prevAssistantTimestamp: null };

		// Walk the cached prefix — validate each entry still matches
		let cacheHitEnd = 0;
		const cacheLen = Math.min(messages.length, this.#cache.length);
		for (let i = 0; i < cacheLen; i++) {
			const entry = this.#cache[i];
			const key = messageCacheKey(messages[i]);
			if (entry.key !== key) break;
			// Cache hit — reuse output, advance state
			if (entry.output !== undefined) {
				result.push(entry.output);
			}
			state = entry.postState;
			cacheHitEnd = i + 1;
		}

		// Truncate stale entries
		this.#cache.length = cacheHitEnd;

		// Render remaining messages
		for (let i = cacheHitEnd; i < messages.length; i++) {
			const m = messages[i];
			const key = messageCacheKey(m);
			const { output, state: newState } = convertOneMessage(m, state);
			state = newState;
			this.#cache.push({ key, postState: state, output });
			if (output !== undefined) {
				result.push(output);
			}
		}

		return result;
	}

	/** Invalidate the entire cache (e.g., after compaction). */
	invalidate(): void {
		this.#cache = [];
	}
}

// =============================================================================
// Public API — stateless (backward compatible) and cached
// =============================================================================

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is the stateless version — re-renders all messages on every call.
 * Used by:
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 * - Tests
 *
 * For the hot path (agent loop), use CachedMessageConverter instead.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const result: Message[] = [];
	let state: FoldState = { turnIndex: 0, prevAssistantTimestamp: null };

	for (const m of messages) {
		const { output, state: newState } = convertOneMessage(m, state);
		state = newState;
		if (output !== undefined) {
			result.push(output);
		}
	}

	return result;
}
