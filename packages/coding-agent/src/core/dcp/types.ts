/**
 * DCP Core Types — the algebra.
 *
 * These are the ADTs. If you squint, it's Haskell with worse syntax.
 * Port guide: every `type X = { tag: "a", ... } | { tag: "b", ... }`
 * becomes `data X = A ... | B ...` in Haskell.
 *
 * No classes. No methods. Just types and functions over them.
 */

// ============================================================================
// Content Addressing
// ============================================================================

/**
 * newtype ContentHash = ContentHash ByteString
 *
 * 32-byte KangarooTwelve hash, hex-encoded for TS phase.
 * Haskell: newtype over ByteString with Eq, Ord, Hashable.
 */
export type ContentHash = string & { readonly __brand: "ContentHash" };

/** Smart constructor. In Haskell: mkContentHash :: ByteString -> ContentHash */
export function mkContentHash(hex: string): ContentHash {
	return hex as ContentHash;
}

// ============================================================================
// Handle IDs
// ============================================================================

/**
 * newtype HandleId = HandleId Text
 *
 * Opaque handle reference. The §h7 notation from the design doc.
 */
export type HandleId = string & { readonly __brand: "HandleId" };

let _handleCounter = 0;

export function freshHandleId(): HandleId {
	return `§h${_handleCounter++}` as HandleId;
}

export function resetHandleCounter(): void {
	_handleCounter = 0;
}

// ============================================================================
// Residency — where content lives
// ============================================================================

/**
 * data Residency
 *   = Raw                    -- full verbatim in context
 *   | Skeletal ContentHash   -- compressed form, full in store
 *   | HandleOnly HandleId    -- just a reference, result in store
 *   | Evicted ContentHash    -- not in context at all, only in store
 */
export type Residency =
	| { readonly tag: "Raw" }
	| { readonly tag: "Skeletal"; readonly storeRef: ContentHash }
	| { readonly tag: "HandleOnly"; readonly handleId: HandleId }
	| { readonly tag: "Evicted"; readonly storeRef: ContentHash };

export const Raw: Residency = { tag: "Raw" };
export const Skeletal = (storeRef: ContentHash): Residency => ({ tag: "Skeletal", storeRef });
export const HandleOnly = (handleId: HandleId): Residency => ({ tag: "HandleOnly", handleId });
export const Evicted = (storeRef: ContentHash): Residency => ({ tag: "Evicted", storeRef });

// ============================================================================
// Blob — content-addressed storage unit
// ============================================================================

/**
 * data BlobType
 *   = RawTurns
 *   | CoT
 *   | SkeletalForm
 *   | ToolResult
 *   | GraphDelta
 */
export type BlobType = "RawTurns" | "CoT" | "SkeletalForm" | "ToolResult" | "GraphDelta";

/**
 * data Blob = Blob
 *   { blobHash      :: ContentHash
 *   , blobType      :: BlobType
 *   , blobSizeBytes :: Int
 *   , blobContent   :: ByteString   -- inline if small
 *   , blobSessionId :: Maybe Text
 *   , blobCreatedAt :: UTCTime
 *   }
 */
export interface Blob {
	readonly hash: ContentHash;
	readonly type: BlobType;
	readonly sizeBytes: number;
	readonly content: string;
	readonly sessionId: string | undefined;
	readonly createdAt: number; // epoch ms
}

// ============================================================================
// Chunk — unit of context
// ============================================================================

/**
 * data ChunkLevel = LRaw | LSkeletal | LReferential | LEvicted
 *
 * Haskell: deriving (Eq, Ord, Enum, Bounded)
 */
export type ChunkLevel = "Raw" | "Skeletal" | "Referential" | "Evicted";

/**
 * data Chunk = Chunk
 *   { chunkId        :: ContentHash
 *   , chunkLevel     :: ChunkLevel
 *   , chunkTurnStart :: Int
 *   , chunkTurnEnd   :: Int
 *   , chunkTags      :: [Text]
 *   , chunkTokensRaw :: Int
 *   , chunkTokensNow :: Int
 *   , chunkPinned    :: Bool
 *   , chunkPinReason :: Maybe Text
 *   , chunkRawHash   :: Maybe ContentHash
 *   , chunkSkelHash  :: Maybe ContentHash
 *   , chunkCotHash   :: Maybe ContentHash
 *   , chunkCreatedAt :: UTCTime
 *   , chunkAccessedAt :: UTCTime
 *   }
 */
export interface Chunk {
	readonly id: ContentHash;
	readonly level: ChunkLevel;
	readonly turnStart: number;
	readonly turnEnd: number;
	readonly tags: readonly string[];
	readonly tokensRaw: number;
	readonly tokensNow: number;
	readonly pinned: boolean;
	readonly pinReason: string | undefined;
	readonly rawHash: ContentHash | undefined;
	readonly skelHash: ContentHash | undefined;
	readonly cotHash: ContentHash | undefined;
	readonly createdAt: number;
	readonly accessedAt: number;
}

// ============================================================================
// Dependency edges between chunks
// ============================================================================

/**
 * data DepType = DependsOn | Feeds | Coreference
 */
export type DepType = "DependsOn" | "Feeds" | "Coreference";

/**
 * data ChunkDep = ChunkDep
 *   { depFrom :: ContentHash
 *   , depTo   :: ContentHash
 *   , depType :: DepType
 *   }
 */
export interface ChunkDep {
	readonly from: ContentHash;
	readonly to: ContentHash;
	readonly depType: DepType;
}

// ============================================================================
// Handle — thunk for tool results (CBN)
// ============================================================================

/**
 * data HandleStatus
 *   = Pending
 *   | Resolved { resolvedAt :: UTCTime }
 *   | Consumed { consumedAt :: UTCTime }
 *   | HEvicted
 */
export type HandleStatus =
	| { readonly tag: "Pending" }
	| { readonly tag: "Resolved"; readonly resolvedAt: number }
	| { readonly tag: "Consumed"; readonly consumedAt: number }
	| { readonly tag: "HEvicted" };

export const Pending: HandleStatus = { tag: "Pending" };
export const Resolved = (resolvedAt: number): HandleStatus => ({ tag: "Resolved", resolvedAt });
export const Consumed = (consumedAt: number): HandleStatus => ({ tag: "Consumed", consumedAt });
export const HEvicted: HandleStatus = { tag: "HEvicted" };

/**
 * data Idempotency = Pure | Session | NonIdempotent
 *
 * Pure: safe to cache, re-execute, dedup
 * Session: stable within session, cache with invalidation
 * NonIdempotent: side effects, must use stored result
 */
export type Idempotency = "Pure" | "Session" | "NonIdempotent";

/**
 * data Handle = Handle
 *   { handleId            :: HandleId
 *   , handleSourceTool    :: Text
 *   , handleSourceArgs    :: Value        -- JSON
 *   , handleStatus        :: HandleStatus
 *   , handleIdempotency   :: Idempotency
 *   , handleResultHash    :: Maybe ContentHash
 *   , handleTotalTokens   :: Maybe Int
 *   , handleMatTokens     :: Int          -- materialized so far
 *   , handleChunkId       :: Maybe ContentHash
 *   , handleTurnIndex     :: Int
 *   , handleCreatedAt     :: UTCTime
 *   }
 */
export interface Handle {
	readonly id: HandleId;
	readonly sourceTool: string;
	readonly sourceArgs: unknown;
	readonly status: HandleStatus;
	readonly idempotency: Idempotency;
	readonly resultHash: ContentHash | undefined;
	readonly totalTokens: number | undefined;
	readonly materializedTokens: number;
	readonly chunkId: ContentHash | undefined;
	readonly turnIndex: number;
	readonly createdAt: number;
}

// ============================================================================
// Idempotency classification
// ============================================================================

/**
 * classifyBash :: Text -> Idempotency
 *
 * Haskell: pattern match on the command prefix.
 * Conservative: unknown -> NonIdempotent.
 */
export function classifyBash(command: string): Idempotency {
	const trimmed = command.trim();

	// Pure read-only commands
	const purePatterns = [
		/^(cat|head|tail|wc|grep|rg|find|fd|ls|stat|file|which|type|echo|printf)\b/,
		/^(readlink|realpath|basename|dirname|pwd|whoami|id|date|uname)\b/,
		/^(jq|yq|awk|sed\s+-n|sort|uniq|tr|cut|paste|column|diff|comm)\b/,
		/^(sha256sum|md5sum|xxd|hexdump|od)\b/,
		/^(git\s+(log|show|diff|status|branch|tag|rev-parse|ls-files|blame))\b/,
		/^(cargo\s+(check|clippy|doc))\b/,
		/^(node\s+-e|python3?\s+-c)\b/, // inline scripts (iffy but usually pure)
	];

	for (const p of purePatterns) {
		if (p.test(trimmed)) return "Pure";
	}

	// Session-stable (deterministic if source hasn't changed)
	const sessionPatterns = [
		/^(cargo\s+test)\b/,
		/^(npm\s+(test|run\s+test|run\s+check|run\s+lint))\b/,
		/^(git\s+stash\s+list)\b/,
		/^(curl\s+(-s\s+)?(-X\s+)?GET)\b/,
		/^(curl\s+-s)\b/,
	];

	for (const p of sessionPatterns) {
		if (p.test(trimmed)) return "Session";
	}

	// Everything else: assume side effects
	return "NonIdempotent";
}

/**
 * classifyTool :: Text -> Idempotency
 *
 * For non-bash tools.
 */
export function classifyTool(toolName: string): Idempotency {
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls":
			return "Pure";
		case "write":
		case "edit":
			return "NonIdempotent";
		case "bash":
			return "Session"; // caller should use classifyBash for specifics
		default:
			return "NonIdempotent";
	}
}

// ============================================================================
// Oracle operations — the operator's vocabulary
// ============================================================================

/**
 * data OracleOp
 *   = Pin ContentHash Text         -- pin chunk with reason
 *   | Unpin ContentHash
 *   | Edit ContentHash Text         -- edit chunk content
 *   | Inject Text                   -- inject new content
 *   | Promote ContentHash           -- move to higher residency
 *   | Demote ContentHash            -- move to lower residency
 *   | Tag ContentHash [Text]        -- set tags
 */
export type OracleOp =
	| { readonly tag: "Pin"; readonly chunkId: ContentHash; readonly reason: string }
	| { readonly tag: "Unpin"; readonly chunkId: ContentHash }
	| { readonly tag: "Edit"; readonly chunkId: ContentHash; readonly content: string }
	| { readonly tag: "Inject"; readonly content: string }
	| { readonly tag: "Promote"; readonly chunkId: ContentHash }
	| { readonly tag: "Demote"; readonly chunkId: ContentHash }
	| { readonly tag: "Tag"; readonly chunkId: ContentHash; readonly tags: readonly string[] };

// ============================================================================
// Compaction event
// ============================================================================

/**
 * data CompactionEvent = CompactionEvent
 *   { ceChunksIn        :: [ContentHash]
 *   , ceChunkOut        :: ContentHash
 *   , ceTokensFreed     :: Int
 *   , ceRerollCost      :: Int
 *   , ceCloneSessionId  :: Maybe Text
 *   , cePressureBefore  :: Double
 *   , cePressureAfter   :: Double
 *   , ceCreatedAt       :: UTCTime
 *   }
 */
export interface CompactionEvent {
	readonly chunksIn: readonly ContentHash[];
	readonly chunkOut: ContentHash;
	readonly tokensFreed: number;
	readonly rerollCost: number;
	readonly cloneSessionId: string | undefined;
	readonly pressureBefore: number;
	readonly pressureAfter: number;
	readonly createdAt: number;
}

// ============================================================================
// Context pressure
// ============================================================================

/**
 * data PressureLevel = Low | Medium | High | Critical
 *
 * Low:      < 50% context used
 * Medium:   50-75%
 * High:     75-90%
 * Critical: > 90%
 */
export type PressureLevel = "Low" | "Medium" | "High" | "Critical";

export function pressureLevel(used: number, total: number): PressureLevel {
	const ratio = used / total;
	if (ratio < 0.5) return "Low";
	if (ratio < 0.75) return "Medium";
	if (ratio < 0.9) return "High";
	return "Critical";
}

/**
 * Materialization budget per turn, varies with pressure.
 *
 * materializationBudget :: PressureLevel -> Int
 */
export function materializationBudget(pressure: PressureLevel): number {
	switch (pressure) {
		case "Low":
			return 8000;
		case "Medium":
			return 4000;
		case "High":
			return 2000;
		case "Critical":
			return 500;
	}
}

// ============================================================================
// Page table — the TLB
// ============================================================================

/**
 * data PageTable = PageTable
 *   { ptChunks   :: Map ContentHash Chunk
 *   , ptHandles  :: Map HandleId Handle
 *   , ptDeps     :: [ChunkDep]
 *   , ptPressure :: PressureLevel
 *   }
 *
 * The page table is the central data structure. Everything else
 * (store, oracle, compaction) reads/writes through it.
 *
 * In Haskell this would be an IORef or TVar for the mutable bits,
 * with pure query functions over the snapshot.
 */
export interface PageTable {
	readonly chunks: ReadonlyMap<ContentHash, Chunk>;
	readonly handles: ReadonlyMap<HandleId, Handle>;
	readonly deps: readonly ChunkDep[];
	readonly pressure: PressureLevel;
}

/** Empty page table. mempty for PageTable. */
export function emptyPageTable(): PageTable {
	return {
		chunks: new Map(),
		handles: new Map(),
		deps: [],
		pressure: "Low",
	};
}

// ============================================================================
// Page table operations — pure functions
// ============================================================================

/** Insert or update a chunk. Returns new PageTable. */
export function ptInsertChunk(pt: PageTable, chunk: Chunk): PageTable {
	const chunks = new Map(pt.chunks);
	chunks.set(chunk.id, chunk);
	return { ...pt, chunks };
}

/** Insert or update a handle. Returns new PageTable. */
export function ptInsertHandle(pt: PageTable, handle: Handle): PageTable {
	const handles = new Map(pt.handles);
	handles.set(handle.id, handle);
	return { ...pt, handles };
}

/** Add a dependency edge. Returns new PageTable. */
export function ptAddDep(pt: PageTable, dep: ChunkDep): PageTable {
	return { ...pt, deps: [...pt.deps, dep] };
}

/** Update pressure level. */
export function ptSetPressure(pt: PageTable, pressure: PressureLevel): PageTable {
	return { ...pt, pressure };
}

/** Get all chunks that depend on a given chunk (incoming edges). */
export function ptDependents(pt: PageTable, chunkId: ContentHash): readonly ChunkDep[] {
	return pt.deps.filter((d) => d.to === chunkId);
}

/** Get all chunks that a given chunk depends on (outgoing edges). */
export function ptDependencies(pt: PageTable, chunkId: ContentHash): readonly ChunkDep[] {
	return pt.deps.filter((d) => d.from === chunkId);
}

/** Check if a chunk is pinned or has live dependents (GC root check). */
export function ptIsRoot(pt: PageTable, chunkId: ContentHash): boolean {
	const chunk = pt.chunks.get(chunkId);
	if (!chunk) return false;
	if (chunk.pinned) return true;
	return ptDependents(pt, chunkId).length > 0;
}

/** Resolve a handle by ID. Maybe Handle. */
export function ptLookupHandle(pt: PageTable, id: HandleId): Handle | undefined {
	return pt.handles.get(id);
}

/** All handles in a given status. */
export function ptHandlesByStatus(pt: PageTable, tag: HandleStatus["tag"]): readonly Handle[] {
	return Array.from(pt.handles.values()).filter((h) => h.status.tag === tag);
}

/** Touch a chunk (update accessedAt). Pure — returns new PageTable. */
export function ptTouchChunk(pt: PageTable, chunkId: ContentHash, now: number): PageTable {
	const chunk = pt.chunks.get(chunkId);
	if (!chunk) return pt;
	return ptInsertChunk(pt, { ...chunk, accessedAt: now });
}

// ============================================================================
// Handle cache key — for idempotent dedup
// ============================================================================

/**
 * handleCacheKey :: Text -> Value -> Maybe Text
 *
 * For pure tool calls, returns a deterministic cache key.
 * Same tool + same args + pure = same result. Dedup.
 */
export function handleCacheKey(toolName: string, args: unknown): string | undefined {
	const idempotency =
		toolName === "bash" && typeof args === "object" && args !== null && "command" in args
			? classifyBash((args as { command: string }).command)
			: classifyTool(toolName);

	if (idempotency !== "Pure") return undefined;

	// Deterministic JSON for cache key
	return `${toolName}:${JSON.stringify(args, Object.keys(args as object).sort())}`;
}
