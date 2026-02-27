/**
 * DCP Runtime — wires DCP into the agent session.
 *
 * This is the integration layer. It:
 * 1. Opens/closes the store
 * 2. Intercepts tool calls for handle-based capture
 * 3. Registers push-down DSL tools (handle_lines, handle_grep, etc.)
 * 4. Captures CoT on turn_end
 * 5. Injects context pressure warnings
 * 6. Provides DCP-aware compaction
 *
 * data DcpRuntime = DcpRuntime
 *   { dcpStore       :: Store
 *   , dcpTurnIndex   :: IORef Int
 *   , dcpSessionId   :: Text
 *   , dcpEnabled     :: Bool
 *   }
 *
 * In Haskell this would be a ReaderT DcpRuntime IO monad.
 */

import type { AgentMessage } from "@punkin-pi/agent-core";
import type { AssistantMessage } from "@punkin-pi/ai";
import { captureCoT, captureResult, decideIntercept, execHandleOp, type HandleOp } from "./interceptor.js";
import { loadTemplate } from "./prompts/loader.js";
import type { Store } from "./store.js";
import { closeStore, getBlobContent, openStore } from "./store.js";
import type { HandleId } from "./types.js";
import { pressureLevel } from "./types.js";

// Template hashes now live in prompts/hashes.toml — not here.

// ============================================================================
// Runtime state
// ============================================================================

export interface DcpRuntime {
	store: Store;
	turnIndex: number;
	sessionId: string;
	enabled: boolean;
	/** Track CoT hashes per turn for compaction enrichment */
	cotByTurn: Map<number, string>; // turnIndex -> ContentHash
}

/**
 * initRuntime :: Maybe FilePath -> Text -> IO DcpRuntime
 */
export function initRuntime(storePath: string | undefined, sessionId: string): DcpRuntime {
	return {
		store: openStore(storePath),
		turnIndex: 0,
		sessionId,
		enabled: true,
		cotByTurn: new Map(),
	};
}

/**
 * shutdownRuntime :: DcpRuntime -> IO ()
 */
export function shutdownRuntime(rt: DcpRuntime): void {
	closeStore(rt.store);
}

// ============================================================================
// Tool call interception
// ============================================================================

/**
 * data ToolCallIntercept
 *   = SkipExecution Text          -- return this text instead of executing
 *   | ExecuteAndCapture HandleId  -- execute, then call onResult
 */
export type ToolCallIntercept =
	| { readonly tag: "SkipExecution"; readonly resultText: string }
	| { readonly tag: "ExecuteAndCapture"; readonly handleId: HandleId };

/**
 * interceptToolCall :: DcpRuntime -> Text -> Value -> IO ToolCallIntercept
 *
 * Called BEFORE a tool executes. Returns whether to skip (cached)
 * or execute and capture.
 */
export function interceptToolCall(rt: DcpRuntime, toolName: string, args: unknown): ToolCallIntercept {
	if (!rt.enabled) {
		return { tag: "ExecuteAndCapture", handleId: "" as HandleId };
	}

	const decision = decideIntercept(rt.store, toolName, args);

	switch (decision.tag) {
		case "UseCached":
			return { tag: "SkipExecution", resultText: decision.resultText };
		case "Execute":
			return { tag: "ExecuteAndCapture", handleId: decision.handleId };
	}
}

/**
 * interceptToolResult :: DcpRuntime -> HandleId -> Text -> IO Text
 *
 * Called AFTER a tool executes. Captures result to store,
 * returns either the full result or a handle summary depending
 * on materialization budget.
 */
export function interceptToolResult(
	rt: DcpRuntime,
	handleId: HandleId,
	resultText: string,
	contextTokens: number,
	contextWindow: number,
): string {
	if (!rt.enabled) return resultText;

	const pressure = pressureLevel(contextTokens, contextWindow);
	const captured = captureResult(rt.store, handleId, resultText, pressure, rt.turnIndex);

	switch (captured.tag) {
		case "Materialized":
			return captured.text;
		case "Summarized":
			return captured.summary;
	}
}

// ============================================================================
// CoT capture
// ============================================================================

/**
 * onTurnEnd :: DcpRuntime -> AssistantMessage -> IO ()
 *
 * Called at end of each turn. Extracts and stores CoT.
 */
export function onTurnEnd(rt: DcpRuntime, message: AgentMessage): void {
	if (!rt.enabled) return;
	if (message.role !== "assistant") return;

	const assistantMsg = message as AssistantMessage;
	const cotHash = captureCoT(rt.store, assistantMsg.content, rt.sessionId);
	if (cotHash) {
		rt.cotByTurn.set(rt.turnIndex, cotHash);
	}
	rt.turnIndex++;
}

// ============================================================================
// Context pressure
// ============================================================================

/**
 * pressureWarning :: Int -> Int -> Maybe Text
 *
 * Returns a system prompt injection if context pressure is elevated.
 * The model should know it's running low on context so it can
 * be more concise and use handles instead of materializing.
 */
export function pressureWarning(contextTokens: number, contextWindow: number): string | undefined {
	const pressure = pressureLevel(contextTokens, contextWindow);

	switch (pressure) {
		case "Low":
			return undefined;
		case "Medium":
			return loadTemplate("pressure-medium.md").trim();
		case "High":
			return loadTemplate("pressure-high.md").trim();
		case "Critical":
			return loadTemplate("pressure-critical.md").trim();
	}
}

// ============================================================================
// System prompt additions for DCP
// ============================================================================

/**
 * The DCP system prompt block. Injected once on session start.
 * Teaches the model about handles and the push-down DSL.
 */
// Loaded from prompts/handle-tools.md — hash verified against prompts/hashes.toml
export const HANDLE_TOOLS_PROMPT = loadTemplate("handle-tools.md").trim();

/**
 * Boot sequence instructions. Tells the model to paraphrase AGENTS.md
 * and loaded skills on first turn before responding.
 */
// Loaded from prompts/boot-sequence.md — hash verified against prompts/hashes.toml
export const BOOT_SEQUENCE_PROMPT = loadTemplate("boot-sequence.md").trim();

// ============================================================================
// Push-down DSL tool definitions
// ============================================================================

/**
 * The tool definitions for the push-down DSL.
 * These get registered with the agent via registerTool.
 *
 * Each tool is a thin wrapper that parses args and calls execHandleOp.
 */

export interface PushDownToolDef {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
	execute: (rt: DcpRuntime, args: Record<string, unknown>) => string;
}

export const PUSHDOWN_TOOLS: readonly PushDownToolDef[] = [
	{
		name: "handle_lines",
		description: "Read specific lines from a handle's stored result. 1-indexed.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				start: { type: "number", description: "Start line (1-indexed)" },
				end: { type: "number", description: "End line (inclusive)" },
			},
			required: ["handle", "start", "end"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HLines", start: args.start as number, end: args.end as number };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_grep",
		description: "Search a handle's stored result for lines matching a pattern (regex or string).",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				pattern: { type: "string", description: "Search pattern (regex or string)" },
			},
			required: ["handle", "pattern"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HGrep", pattern: args.pattern as string };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_head",
		description: "Read the first N lines from a handle's stored result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				n: { type: "number", description: "Number of lines" },
			},
			required: ["handle", "n"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HHead", n: args.n as number };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_tail",
		description: "Read the last N lines from a handle's stored result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				n: { type: "number", description: "Number of lines" },
			},
			required: ["handle", "n"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HTail", n: args.n as number };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_count",
		description: "Count lines in a handle's stored result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
			},
			required: ["handle"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HCount" };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_count_matches",
		description: "Count lines matching a pattern in a handle's stored result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				pattern: { type: "string", description: "Search pattern (regex or string)" },
			},
			required: ["handle", "pattern"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HCountMatches", pattern: args.pattern as string };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
	{
		name: "handle_slice",
		description: "Read a byte range from a handle's stored result.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "Handle ID (e.g. §h7)" },
				offset: { type: "number", description: "Byte offset" },
				length: { type: "number", description: "Number of bytes" },
			},
			required: ["handle", "offset", "length"],
		},
		execute: (rt, args) => {
			const op: HandleOp = { tag: "HSlice", offset: args.offset as number, length: args.length as number };
			const result = execHandleOp(rt.store, args.handle as HandleId, op);
			return result.ok ? result.result : `Error: ${result.error}`;
		},
	},
] as const;

// ============================================================================
// Compaction enrichment — include CoT in compaction input
// ============================================================================

/**
 * enrichCompactionInput :: DcpRuntime -> [AgentMessage] -> Text
 *
 * When compaction fires, build enriched input that includes
 * the stored CoT alongside the raw turns. This gives the
 * compaction summarizer access to the model's reasoning,
 * not just its output.
 *
 * "Compacting turns without preserving CoT is like compacting
 *  a function to its return value and throwing away the stack frames."
 */
export function enrichCompactionInput(rt: DcpRuntime, messages: readonly AgentMessage[]): string {
	const parts: string[] = [];

	let turnIdx = 0;
	for (const msg of messages) {
		if (msg.role === "user" || msg.role === "assistant") {
			// Check if we have stored CoT for this turn
			const cotHash = rt.cotByTurn.get(turnIdx);
			if (cotHash) {
				const cotContent = getBlobContent(rt.store, cotHash as any);
				if (cotContent) {
					parts.push(`[Turn ${turnIdx} reasoning (from CoT store)]:`);
					parts.push(cotContent);
					parts.push("");
				}
			}
		}
		if (msg.role === "assistant") {
			turnIdx++;
		}
	}

	return parts.join("\n");
}

// ============================================================================
// CoT replay tool — let the model re-read its own past reasoning
// ============================================================================

export const COT_REPLAY_TOOL: PushDownToolDef = {
	name: "cot_replay",
	description:
		"Re-read your own chain of thought from a previous turn. Use when you need to recall your reasoning about a past decision.",
	parameters: {
		type: "object",
		properties: {
			turn: { type: "number", description: "Turn index to replay CoT from (0-indexed)" },
		},
		required: ["turn"],
	},
	execute: (rt, args) => {
		const turnIdx = args.turn as number;
		const cotHash = rt.cotByTurn.get(turnIdx);
		if (!cotHash) return `No stored CoT for turn ${turnIdx}.`;

		const content = getBlobContent(rt.store, cotHash as any);
		if (!content) return `CoT blob not found for turn ${turnIdx}.`;

		return content;
	},
};
