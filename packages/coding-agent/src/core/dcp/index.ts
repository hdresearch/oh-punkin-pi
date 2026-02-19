/**
 * DCP — Dynamic Compaction Protocol
 *
 * Re-exports for the public API.
 *
 * module DCP
 *   ( module DCP.Types
 *   , module DCP.Store
 *   , module DCP.Interceptor
 *   , module DCP.Runtime
 *   ) where
 */

// Interceptor
export type { CaptureResult, HandleOp, InterceptDecision } from "./interceptor.js";
export { captureCoT, captureResult, decideIntercept, execHandleOp } from "./interceptor.js";
// Runtime
export type { DcpRuntime, PushDownToolDef, ToolCallIntercept } from "./runtime.js";
export {
	COT_REPLAY_TOOL,
	DCP_SYSTEM_PROMPT,
	enrichCompactionInput,
	initRuntime,
	interceptToolCall,
	interceptToolResult,
	onTurnEnd,
	PUSHDOWN_TOOLS,
	pressureWarning,
	shutdownRuntime,
} from "./runtime.js";
// Session hook
export type { DcpHook } from "./session-hook.js";
export { createDcpHook } from "./session-hook.js";
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
