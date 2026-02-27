/**
 * Turn Bracket — wraps assistant turns with structured boundaries.
 *
 * Format mirrors user message brackets for continuity.
 * Open tag is prefilled (model sees it), close tag appended by system.
 *
 * data TurnBracketState = TurnBracketState
 *   { tbSigils :: (Sigil, Sigil)      -- (user, squiggle)
 *   , tbNonces :: (Nonce, Nonce)      -- (user, squiggle)  
 *   , tbTurn   :: Int
 *   , tbStart  :: UTCTime
 *   , tbOpen   :: Text
 *   }
 */

import { createHash, randomBytes } from "node:crypto";
import { USER_CODEBOOK, SQUIGGLE_CODEBOOK } from "@punkin-pi/ai";

// ============================================================================
// Types
// ============================================================================

export interface TurnBracketState {
	readonly sigils: { user: string; squiggle: string };
	readonly nonces: { user: string; squiggle: string };
	readonly turn: number;
	readonly startTime: number;
	readonly openTag: string;
}

// ============================================================================
// Pure helpers
// ============================================================================

function pick<T>(arr: readonly T[]): T {
	const entropy = randomBytes(2);
	return arr[entropy.readUInt16BE(0) % arr.length];
}

function nonce(words: readonly string[]): string {
	return `${pick(words)}-${pick(words)}-${pick(words)}`;
}

function nycTimestamp(): { iso: string; short: string } {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = formatter.formatToParts(now);
	const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

	const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}-05:00`;
	const short = `${get("hour")}:${get("minute")}:${get("second")}`;

	return { iso, short };
}

function sha3Trunc(content: string): string {
	return createHash("sha3-256").update(content).digest("hex").slice(0, 12);
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (seconds < 300) return `${minutes}m${remainingSeconds}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (remainingMinutes === 0) return `${hours}h`;
	return `${hours}h${remainingMinutes}m`;
}

// ============================================================================
// Bracket generation (pure)
// ============================================================================

/**
 * mkOpenBracket :: Int -> TurnBracketState
 * 
 * Generates bracket state with open tag.
 * Format: [assistant]{sigil nonce T=timestamp turn:N {
 */
export function mkOpenBracket(turn: number): TurnBracketState {
	const sigils = {
		user: pick(USER_CODEBOOK.sigils),
		squiggle: pick(SQUIGGLE_CODEBOOK.sigils),
	};
	const nonces = {
		user: nonce(USER_CODEBOOK.words),
		squiggle: nonce(SQUIGGLE_CODEBOOK.words),
	};
	const ts = nycTimestamp();
	const startTime = Date.now();

	const openTag = `[assistant]{${sigils.user} ${nonces.user} T=${ts.iso} turn:${turn} {`;

	return { sigils, nonces, turn, startTime, openTag };
}

/**
 * mkCloseTag :: TurnBracketState -> Text -> Text
 * 
 * Generates close tag with content hash.
 * Format: } T=HH:MM:SS H=hash nonce sigil}
 */
export function mkCloseTag(state: TurnBracketState, content: string): string {
	const ts = nycTimestamp();
	const hash = sha3Trunc(content);
	const duration = formatDuration(Date.now() - state.startTime);

	return `} T=${ts.short} H=${hash} Δ${duration} ${state.nonces.user} ${state.sigils.user}}`;
}

/**
 * wrapContent :: TurnBracketState -> Text -> Text
 * 
 * Wraps content with open and close tags (rich metadata mode).
 */
export function wrapContent(state: TurnBracketState, content: string): string {
	const closeTag = mkCloseTag(state, content);
	return `${state.openTag}\n${content}\n${closeTag}`;
}

// ============================================================================
// Simple bracket (always-on structural wrapper, no metadata)
// ============================================================================

/** Plain open tag — no sigil/nonce/timestamp, just structural. */
export const SIMPLE_OPEN_TAG = "[assistant]{";

/** Plain close tag. */
export const SIMPLE_CLOSE_TAG = "}";

/**
 * wrapSimple :: Text -> Text
 *
 * Wraps content with plain structural brackets only.
 * Format: [assistant]{\ncontent\n}
 */
export function wrapSimple(content: string): string {
	return `${SIMPLE_OPEN_TAG}\n${content}\n${SIMPLE_CLOSE_TAG}`;
}
