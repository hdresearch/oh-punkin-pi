/**
 * Carter Kit — Context management, handles, CoT persistence
 *
 * Re-exports for the public API.
 */

// Interceptor
export type { CaptureResult, HandleOp, InterceptDecision } from "./interceptor.js";
export { captureCoT, captureResult, decideIntercept, execHandleOp } from "./interceptor.js";
// Runtime
export type { DcpRuntime, PushDownToolDef, ToolCallIntercept } from "./runtime.js";
export {
	COT_REPLAY_TOOL,
	enrichCompactionInput,
	HANDLE_TOOLS_PROMPT,
	initRuntime,
	interceptToolCall,
	interceptToolResult,
	onTurnEnd,
	PUSHDOWN_TOOLS,
	pressureWarning,
	shutdownRuntime,
} from "./runtime.js";
// Session hook
export type { CarterKitHook } from "./session-hook.js";
export { createCarterKitHook } from "./session-hook.js";
// Store
export type { Store } from "./store.js";
export {
	closeStore,
	getBlob,
	getBlobContent,
	getChunk,
	getHandle,
	hash,
	openStore,
	putBlob,
	putChunk,
	putHandle,
} from "./store.js";
// Types — the algebra
export type {
	Blob,
	BlobType,
	Chunk,
	ChunkDep,
	ChunkLevel,
	CompactionEvent,
	ContentHash,
	DepType,
	Handle,
	HandleId,
	HandleStatus,
	Idempotency,
	OracleOp,
	PageTable,
	PressureLevel,
	Residency,
} from "./types.js";
export {
	Consumed,
	classifyBash,
	classifyTool,
	Evicted,
	emptyPageTable,
	freshHandleId,
	HandleOnly,
	HEvicted,
	handleCacheKey,
	materializationBudget,
	mkContentHash,
	Pending,
	pressureLevel,
	ptAddDep,
	ptDependencies,
	ptDependents,
	ptHandlesByStatus,
	ptInsertChunk,
	ptInsertHandle,
	ptIsRoot,
	ptLookupHandle,
	ptSetPressure,
	ptTouchChunk,
	Raw,
	Resolved,
	resetHandleCounter,
	Skeletal,
} from "./types.js";
