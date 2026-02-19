/**
 * DCP Store — content-addressed blob store + page table persistence.
 *
 * TS phase: in-memory Maps, JSON file for persistence.
 * Haskell phase: DuckDB + mmap'd blob files + K12 hashing.
 *
 * The interface is what matters. The implementation is throwaway.
 *
 * data Store = Store
 *   { storeBlobs     :: IORef (Map ContentHash Blob)
 *   , storePageTable :: IORef PageTable
 *   , storeHandleCache :: IORef (Map Text HandleId)  -- dedup cache
 *   , storePath      :: FilePath
 *   }
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Blob,
	BlobType,
	Chunk,
	CompactionEvent,
	ContentHash,
	Handle,
	HandleId,
	OracleOp,
	PageTable,
} from "./types.js";
import { emptyPageTable, mkContentHash, ptInsertChunk, ptInsertHandle } from "./types.js";

// ============================================================================
// Content hashing
// ============================================================================

/**
 * hash :: ByteString -> ContentHash
 *
 * SHA-256 for TS phase. K12 in Haskell phase.
 * The hash function is swappable; the ContentHash newtype stays the same.
 */
export function hash(content: string): ContentHash {
	const h = createHash("sha256").update(content).digest("hex");
	return mkContentHash(h);
}

// ============================================================================
// Store type
// ============================================================================

export interface Store {
	/** Content-addressed blobs. Map ContentHash Blob */
	blobs: Map<ContentHash, Blob>;

	/** The page table — chunks, handles, deps, pressure. */
	pageTable: PageTable;

	/** Dedup cache for idempotent tool calls. Map cacheKey HandleId */
	handleCache: Map<string, HandleId>;

	/** Oracle operation log. Append-only. */
	oracleLog: OracleOp[];

	/** Compaction event log. Append-only. */
	compactionLog: CompactionEvent[];

	/** Persistence path (undefined = ephemeral, no persistence). */
	path: string | undefined;
}

// ============================================================================
// Store lifecycle
// ============================================================================

/**
 * openStore :: Maybe FilePath -> IO Store
 *
 * Opens or creates a store. If path is provided, loads from disk.
 */
export function openStore(path?: string): Store {
	if (path && existsSync(join(path, "store.json"))) {
		return loadStore(path);
	}
	return {
		blobs: new Map(),
		pageTable: emptyPageTable(),
		handleCache: new Map(),
		oracleLog: [],
		compactionLog: [],
		path,
	};
}

/**
 * closeStore :: Store -> IO ()
 *
 * Persist to disk if path is set.
 */
export function closeStore(store: Store): void {
	if (store.path) {
		saveStore(store);
	}
}

// ============================================================================
// Blob operations
// ============================================================================

/**
 * putBlob :: Store -> BlobType -> Text -> IO ContentHash
 *
 * Content-addressed insert. Same content = same hash = dedup.
 */
export function putBlob(store: Store, type: BlobType, content: string, sessionId?: string): ContentHash {
	const h = hash(content);
	if (!store.blobs.has(h)) {
		store.blobs.set(h, {
			hash: h,
			type,
			sizeBytes: Buffer.byteLength(content, "utf-8"),
			content,
			sessionId,
			createdAt: Date.now(),
		});
	}
	return h;
}

/**
 * getBlob :: Store -> ContentHash -> IO (Maybe Blob)
 */
export function getBlob(store: Store, h: ContentHash): Blob | undefined {
	return store.blobs.get(h);
}

/**
 * getBlobContent :: Store -> ContentHash -> IO (Maybe Text)
 *
 * Convenience: just the content.
 */
export function getBlobContent(store: Store, h: ContentHash): string | undefined {
	return store.blobs.get(h)?.content;
}

// ============================================================================
// Chunk operations (delegate to PageTable)
// ============================================================================

/**
 * putChunk :: Store -> Chunk -> IO ()
 */
export function putChunk(store: Store, chunk: Chunk): void {
	store.pageTable = ptInsertChunk(store.pageTable, chunk);
}

/**
 * getChunk :: Store -> ContentHash -> IO (Maybe Chunk)
 */
export function getChunk(store: Store, id: ContentHash): Chunk | undefined {
	return store.pageTable.chunks.get(id);
}

// ============================================================================
// Handle operations (delegate to PageTable + dedup cache)
// ============================================================================

/**
 * putHandle :: Store -> Handle -> IO ()
 */
export function putHandle(store: Store, handle: Handle): void {
	store.pageTable = ptInsertHandle(store.pageTable, handle);
}

/**
 * getHandle :: Store -> HandleId -> IO (Maybe Handle)
 */
export function getHandle(store: Store, id: HandleId): Handle | undefined {
	return store.pageTable.handles.get(id);
}

/**
 * lookupCachedHandle :: Store -> Text -> IO (Maybe HandleId)
 *
 * Check dedup cache for an existing handle with the same cache key.
 */
export function lookupCachedHandle(store: Store, cacheKey: string): HandleId | undefined {
	return store.handleCache.get(cacheKey);
}

/**
 * cacheHandle :: Store -> Text -> HandleId -> IO ()
 */
export function cacheHandle(store: Store, cacheKey: string, handleId: HandleId): void {
	store.handleCache.set(cacheKey, handleId);
}

// ============================================================================
// Oracle log
// ============================================================================

/**
 * logOracleOp :: Store -> OracleOp -> IO ()
 */
export function logOracleOp(store: Store, op: OracleOp): void {
	store.oracleLog.push(op);
}

// ============================================================================
// Compaction log
// ============================================================================

/**
 * logCompaction :: Store -> CompactionEvent -> IO ()
 */
export function logCompactionEvent(store: Store, event: CompactionEvent): void {
	store.compactionLog.push(event);
}

// ============================================================================
// Serialization — throwaway, JSON for TS phase
// ============================================================================

interface SerializedStore {
	blobs: Array<[string, Blob]>;
	chunks: Array<[string, Chunk]>;
	handles: Array<[string, Handle]>;
	deps: PageTable["deps"];
	pressure: PageTable["pressure"];
	handleCache: Array<[string, string]>;
	oracleLog: OracleOp[];
	compactionLog: CompactionEvent[];
}

function saveStore(store: Store): void {
	if (!store.path) return;
	mkdirSync(store.path, { recursive: true });

	const serialized: SerializedStore = {
		blobs: Array.from(store.blobs.entries()),
		chunks: Array.from(store.pageTable.chunks.entries()),
		handles: Array.from(store.pageTable.handles.entries()),
		deps: store.pageTable.deps,
		pressure: store.pageTable.pressure,
		handleCache: Array.from(store.handleCache.entries()),
		oracleLog: store.oracleLog,
		compactionLog: store.compactionLog,
	};

	writeFileSync(join(store.path, "store.json"), JSON.stringify(serialized, null, 2));
}

function loadStore(path: string): Store {
	const raw = readFileSync(join(path, "store.json"), "utf-8");
	const s: SerializedStore = JSON.parse(raw);

	return {
		blobs: new Map(s.blobs.map(([k, v]) => [mkContentHash(k), v])),
		pageTable: {
			chunks: new Map(s.chunks.map(([k, v]) => [mkContentHash(k), v])),
			handles: new Map(s.handles.map(([k, v]) => [k as HandleId, v])),
			deps: s.deps,
			pressure: s.pressure,
		},
		handleCache: new Map(s.handleCache) as Map<string, HandleId>,
		oracleLog: s.oracleLog,
		compactionLog: s.compactionLog,
		path,
	};
}
