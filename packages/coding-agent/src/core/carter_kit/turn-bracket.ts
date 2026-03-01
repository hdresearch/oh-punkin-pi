/**
 * Turn Bracket — simple boundaries for assistant turns.
 *
 * Simplified format: no hash, minimal metadata.
 * Used for post-hoc wrapping in convertToLlm (not prefill).
 *
 * data TurnBracket = TurnBracket
 *   { tbSigil :: Sigil
 *   , tbNonce :: Nonce
 *   , tbTurn  :: Int
 *   }
 */

import { randomBytes } from "node:crypto";
import { SQUIGGLE_CODEBOOK } from "@punkin-pi/ai";

// ============================================================================
// Types
// ============================================================================

export interface TurnBracket {
	readonly sigil: string;
	readonly nonce: string;
	readonly turn: number;
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

// ============================================================================
// Bracket generation (pure)
// ============================================================================

/**
 * mkBracket :: Int -> TurnBracket
 *
 * Generates bracket identity for a turn.
 */
export function mkBracket(turn: number): TurnBracket {
	return {
		sigil: pick(SQUIGGLE_CODEBOOK.sigils),
		nonce: nonce(SQUIGGLE_CODEBOOK.words),
		turn,
	};
}

/**
 * formatBracketOpen :: TurnBracket -> String
 *
 * Format: <assistant>
 * Minimal — no metadata to avoid model echoing patterns.
 */
export function formatBracketOpen(_bracket: TurnBracket): string {
	return `<assistant>`;
}

/**
 * formatBracketClose :: TurnBracket -> String
 *
 * Format: </assistant>
 */
export function formatBracketClose(_bracket: TurnBracket): string {
	return `</assistant>`;
}

/**
 * wrapWithBracket :: String -> Int -> String
 *
 * Wrap content with vanilla turn bracket (no sigil/nonce).
 * Minimal format — just role demarcation, no metadata.
 */
export function wrapWithBracket(content: string, _turn: number): string {
	return `<assistant>\n${content}\n</assistant>`;
}

// ============================================================================
// Legacy compatibility (deprecated)
// ============================================================================

/** @deprecated Use TurnBracket instead */
export type TurnBracketState = TurnBracket;

/** @deprecated Use mkBracket instead */
export function mkOpenBracket(turn: number): TurnBracketState {
	return mkBracket(turn);
}

/** @deprecated Use formatBracketClose instead */
export function mkCloseTag(_state: TurnBracketState, _content: string): string {
	// Simplified close tag without hash/timestamp
	return "}";
}
