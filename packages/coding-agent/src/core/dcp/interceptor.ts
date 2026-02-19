/**
 * DCP Tool Interceptor — sits between agent loop and tool execution.
 *
 * Responsibilities:
 * 1. Classify tool calls (idempotency)
 * 2. Dedup pure calls via handle cache
 * 3. Capture results to store
 * 4. Replace fat results with handle summaries when over budget
 * 5. Capture CoT from assistant messages
 *
 * data InterceptResult
 *   = Cached HandleId           -- deduped, return existing handle
 *   | Passthrough               -- execute normally, don't intercept result
 *   | Intercept HandleId        -- execute, but capture result to store
 *
 * In Haskell: this would be a middleware in the tool execution pipeline.
 * Pure classification, IO for store operations.
 */

import type { Store } from "./store.js";
import { cacheHandle, getBlobContent, lookupCachedHandle, putBlob, putHandle } from "./store.js";
import type { ContentHash, Handle, HandleId, Idempotency, PressureLevel } from "./types.js";
import {
	classifyBash,
	classifyTool,
	freshHandleId,
	handleCacheKey,
	materializationBudget,
	Pending,
	Resolved,
} from "./types.js";

// ============================================================================
// Intercept decision
// ============================================================================

/**
 * data InterceptDecision
 *   = UseCached HandleId Text      -- return cached result text
 *   | Execute HandleId Idempotency -- execute and capture
 */
export type InterceptDecision =
	| { readonly tag: "UseCached"; readonly handleId: HandleId; readonly resultText: string }
	| { readonly tag: "Execute"; readonly handleId: HandleId; readonly idempotency: Idempotency };

/**
 * decideIntercept :: Store -> Text -> Value -> IO InterceptDecision
 *
 * Before executing a tool call, decide: dedup or execute?
 */
export function decideIntercept(store: Store, toolName: string, args: unknown): InterceptDecision {
	const idempotency =
		toolName === "bash" && typeof args === "object" && args !== null && "command" in args
			? classifyBash((args as { command: string }).command)
			: classifyTool(toolName);

	// Check dedup cache for pure calls
	const cacheKey = handleCacheKey(toolName, args);
	if (cacheKey) {
		const existingId = lookupCachedHandle(store, cacheKey);
		if (existingId) {
			const handle = store.pageTable.handles.get(existingId);
			if (handle?.resultHash) {
				const content = getBlobContent(store, handle.resultHash);
				if (content) {
					return { tag: "UseCached", handleId: existingId, resultText: content };
				}
			}
		}
	}

	// Fresh handle, will execute
	const handleId = freshHandleId();
	const handle: Handle = {
		id: handleId,
		sourceTool: toolName,
		sourceArgs: args,
		status: Pending,
		idempotency,
		resultHash: undefined,
		totalTokens: undefined,
		materializedTokens: 0,
		chunkId: undefined,
		turnIndex: -1, // set by caller
		createdAt: Date.now(),
	};
	putHandle(store, handle);

	// Cache the handle for future dedup
	if (cacheKey) {
		cacheHandle(store, cacheKey, handleId);
	}

	return { tag: "Execute", handleId, idempotency };
}

// ============================================================================
// Result capture
// ============================================================================

/**
 * data CaptureResult
 *   = Materialized Text          -- result small enough, inline it
 *   | Summarized HandleId Text   -- result too big, replaced with handle summary
 */
export type CaptureResult =
	| { readonly tag: "Materialized"; readonly text: string }
	| { readonly tag: "Summarized"; readonly handleId: HandleId; readonly summary: string };

/**
 * captureResult :: Store -> HandleId -> Text -> PressureLevel -> IO CaptureResult
 *
 * After tool execution, capture the result:
 * - Always store the full result in the blob store
 * - If result fits in materialization budget, return it inline
 * - If too big, return a handle summary
 */
export function captureResult(
	store: Store,
	handleId: HandleId,
	resultText: string,
	pressure: PressureLevel,
	turnIndex: number,
): CaptureResult {
	// Store full result
	const resultHash = putBlob(store, "ToolResult", resultText);
	const estimatedTokens = Math.ceil(resultText.length / 4);

	// Update handle
	const existing = store.pageTable.handles.get(handleId);
	if (existing) {
		const updated: Handle = {
			...existing,
			status: Resolved(Date.now()),
			resultHash,
			totalTokens: estimatedTokens,
			turnIndex,
		};
		putHandle(store, updated);
	}

	// Check materialization budget
	const budget = materializationBudget(pressure);

	if (estimatedTokens <= budget) {
		// Small enough to inline
		if (existing) {
			putHandle(store, {
				...existing,
				status: Resolved(Date.now()),
				resultHash,
				totalTokens: estimatedTokens,
				materializedTokens: estimatedTokens,
				turnIndex,
			});
		}
		return { tag: "Materialized", text: resultText };
	}

	// Too big — return handle summary
	const summary = mkHandleSummary(handleId, existing?.sourceTool ?? "unknown", estimatedTokens, resultText);

	return { tag: "Summarized", handleId, summary };
}

/**
 * mkHandleSummary :: HandleId -> Text -> Int -> Text -> Text
 *
 * Build a compact summary for a handle that replaces fat tool output.
 */
function mkHandleSummary(handleId: HandleId, toolName: string, totalTokens: number, content: string): string {
	const lines = content.split("\n");
	const lineCount = lines.length;

	// First 3 lines as preview
	const preview = lines.slice(0, 3).join("\n");
	// Last line as tail
	const tail = lineCount > 4 ? lines[lineCount - 1] : "";

	return [
		`[Handle ${handleId}: ${toolName} result, ${totalTokens} tokens, ${lineCount} lines]`,
		`Preview:`,
		preview,
		lineCount > 4 ? `... (${lineCount - 4} more lines)` : "",
		tail ? `Last: ${tail}` : "",
		``,
		`Use handle_lines("${handleId}", start, end) to read specific lines.`,
		`Use handle_grep("${handleId}", "pattern") to search.`,
		`Use handle_slice("${handleId}", offset, length) to read a byte range.`,
	]
		.filter(Boolean)
		.join("\n");
}

// ============================================================================
// CoT capture
// ============================================================================

/**
 * captureCoT :: Store -> AssistantMessage -> IO (Maybe ContentHash)
 *
 * Extract thinking blocks from an assistant message and store them.
 * Returns the content hash if CoT was found.
 *
 * "CoT is just text with a tag. No special infrastructure. No opacity theater."
 */
export function captureCoT(
	store: Store,
	messageContent: ReadonlyArray<{ type: string; thinking?: string; text?: string }>,
	sessionId?: string,
): ContentHash | undefined {
	const thinkingBlocks: string[] = [];

	for (const block of messageContent) {
		if (block.type === "thinking" && block.thinking) {
			thinkingBlocks.push(block.thinking);
		}
	}

	if (thinkingBlocks.length === 0) return undefined;

	// Just text. Store it.
	const cotText = thinkingBlocks.join("\n\n---\n\n");
	return putBlob(store, "CoT", cotText, sessionId);
}

// ============================================================================
// Push-down DSL — operations on handles without full materialization
// ============================================================================

/**
 * data HandleOp
 *   = HLines Int Int             -- lines(start, end)
 *   | HGrep Text                 -- grep(pattern)
 *   | HSlice Int Int             -- slice(offset, length)
 *   | HHead Int                  -- head(n)
 *   | HTail Int                  -- tail(n)
 *   | HCount                     -- count_lines()
 *   | HCountMatches Text         -- count_matches(pattern)
 *
 * These execute against the stored blob, never materializing
 * the full content into context.
 */
export type HandleOp =
	| { readonly tag: "HLines"; readonly start: number; readonly end: number }
	| { readonly tag: "HGrep"; readonly pattern: string }
	| { readonly tag: "HSlice"; readonly offset: number; readonly length: number }
	| { readonly tag: "HHead"; readonly n: number }
	| { readonly tag: "HTail"; readonly n: number }
	| { readonly tag: "HCount" }
	| { readonly tag: "HCountMatches"; readonly pattern: string };

/**
 * execHandleOp :: Store -> HandleId -> HandleOp -> IO (Either Text Text)
 *
 * Execute a push-down operation on a handle's stored content.
 * Left = error, Right = result.
 */
export function execHandleOp(
	store: Store,
	handleId: HandleId,
	op: HandleOp,
): { ok: true; result: string } | { ok: false; error: string } {
	const handle = store.pageTable.handles.get(handleId);
	if (!handle) return { ok: false, error: `Handle ${handleId} not found` };
	if (!handle.resultHash) return { ok: false, error: `Handle ${handleId} has no result (still pending?)` };

	const content = getBlobContent(store, handle.resultHash);
	if (!content) return { ok: false, error: `Blob ${handle.resultHash} not found in store` };

	const lines = content.split("\n");

	switch (op.tag) {
		case "HLines": {
			const start = Math.max(0, op.start - 1); // 1-indexed input
			const end = Math.min(lines.length, op.end);
			return { ok: true, result: lines.slice(start, end).join("\n") };
		}
		case "HGrep": {
			try {
				const re = new RegExp(op.pattern, "i");
				const matches = lines.filter((l) => re.test(l));
				if (matches.length === 0) return { ok: true, result: "(no matches)" };
				return { ok: true, result: matches.join("\n") };
			} catch {
				// Fall back to string match
				const matches = lines.filter((l) => l.includes(op.pattern));
				if (matches.length === 0) return { ok: true, result: "(no matches)" };
				return { ok: true, result: matches.join("\n") };
			}
		}
		case "HSlice": {
			return { ok: true, result: content.slice(op.offset, op.offset + op.length) };
		}
		case "HHead": {
			return { ok: true, result: lines.slice(0, op.n).join("\n") };
		}
		case "HTail": {
			return { ok: true, result: lines.slice(-op.n).join("\n") };
		}
		case "HCount": {
			return { ok: true, result: String(lines.length) };
		}
		case "HCountMatches": {
			try {
				const re = new RegExp(op.pattern, "gi");
				const count = lines.filter((l) => re.test(l)).length;
				return { ok: true, result: String(count) };
			} catch {
				const count = lines.filter((l) => l.includes(op.pattern)).length;
				return { ok: true, result: String(count) };
			}
		}
	}
}
