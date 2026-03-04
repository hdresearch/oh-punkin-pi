/**
 * CarterKit Turn Boundary — injection of TurnStartMessage / TurnEndMessage.
 *
 * Turn boundaries are injected AFTER a turn completes, not during generation.
 * This keeps the live generation clean while providing structured demarcation
 * for historical turns.
 */

import { createHash, randomBytes } from "crypto";
import { now, type Timestamp, type TurnStartMessage, type TurnEndMessage, type Message } from "@punkin-pi/ai";

// ============================================================================
// Sigil and Nonce Generation
// ============================================================================

const SIGILS = [
	"🐉", "🐲", "🔮", "🧿", "🌲", "🌿", "🍃", "✨", "📜", "〰",
	"❮", "⟨", "⟪", "『", "《", "【", "〖", "⌊", "«", "⸘",
];

const NONCE_WORDS = [
	// Nature
	"oak", "pine", "cedar", "willow", "birch", "maple", "ash", "elm", "hazel", "rowan",
	"frost", "ember", "storm", "tide", "wave", "reef", "grove", "vale", "peak", "ridge",
	// Materials
	"iron", "steel", "bronze", "copper", "silver", "gold", "jade", "amber", "coral", "pearl",
	"slate", "granite", "marble", "obsidian", "quartz", "crystal", "onyx", "opal", "ruby", "sapphire",
	// Abstract
	"echo", "pulse", "drift", "flux", "vortex", "helix", "prism", "nexus", "arc", "span",
	"dusk", "dawn", "noon", "night", "solar", "lunar", "stellar", "cosmic", "void", "ether",
];

function randomSigil(): string {
	const bytes = randomBytes(1);
	return SIGILS[bytes[0] % SIGILS.length];
}

function randomNonce(): string {
	const bytes = randomBytes(3);
	const words: string[] = [];
	for (let i = 0; i < 3; i++) {
		words.push(NONCE_WORDS[bytes[i] % NONCE_WORDS.length]);
	}
	return words.join("-");
}

function sha3TruncatedTurn(messages: readonly Message[]): string {
	// Hash the content of all messages in the turn
	const content = messages
		.map((m) => {
			if (m.role === "assistant") {
				return m.content
					.map((c) => {
						if (c.type === "text") return c.text;
						if (c.type === "thinking") return c.thinking;
						if (c.type === "toolCall") return `${c.name}(${JSON.stringify(c.arguments)})`;
						return "";
					})
					.join("");
			}
			if (m.role === "toolResult") {
				return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			}
			return "";
		})
		.join("\n");

	const hash = createHash("sha3-256").update(content).digest("hex");
	return hash.slice(0, 12);
}

function formatDelta(fromTs: Timestamp | undefined, toTs: Timestamp): string | undefined {
	if (!fromTs) return undefined;
	const from = new Date(fromTs);
	const to = new Date(toTs);
	const diffMs = to.getTime() - from.getTime();
	const diffSec = Math.floor(diffMs / 1000);

	if (diffSec < 60) return `${diffSec}s`;
	if (diffSec < 300) {
		const m = Math.floor(diffSec / 60);
		const s = diffSec % 60;
		return `${m}m${s}s`;
	}
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
	const h = Math.floor(diffSec / 3600);
	const m = Math.floor((diffSec % 3600) / 60);
	return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// ============================================================================
// Turn Boundary State
// ============================================================================

export interface TurnBoundaryState {
	/** Current turn index */
	currentTurn: number;
	/** Timestamp when current turn started */
	turnStartTimestamp?: Timestamp;
	/** Timestamp when previous turn ended (for delta) */
	previousTurnEndTimestamp?: Timestamp;
	/** Sigil for current turn (assigned at turn start) */
	currentSigil?: string;
	/** Nonce for current turn (assigned at turn start) */
	currentNonce?: string;
}

export function initTurnBoundaryState(): TurnBoundaryState {
	return {
		currentTurn: 0,
	};
}

// ============================================================================
// Turn Lifecycle
// ============================================================================

/**
 * Called when a new assistant turn begins.
 * Records start time and assigns sigil/nonce for this turn.
 */
export function onTurnStart(state: TurnBoundaryState): void {
	state.currentTurn++;
	state.turnStartTimestamp = now();
	state.currentSigil = randomSigil();
	state.currentNonce = randomNonce();
}

/**
 * Called when an assistant turn completes.
 * Creates TurnStartMessage and TurnEndMessage to wrap the turn's messages.
 *
 * @param state - Turn boundary state
 * @param turnMessages - The messages that comprise this turn (assistant + tool results)
 * @returns Tuple of [TurnStartMessage, TurnEndMessage] to inject around the turn
 */
export function onTurnEnd(
	state: TurnBoundaryState,
	turnMessages: readonly Message[],
): [TurnStartMessage, TurnEndMessage] {
	const endTimestamp = now();

	if (!state.turnStartTimestamp || !state.currentSigil || !state.currentNonce) {
		// Shouldn't happen, but handle gracefully
		state.turnStartTimestamp = endTimestamp;
		state.currentSigil = randomSigil();
		state.currentNonce = randomNonce();
	}

	const startTs = state.turnStartTimestamp;
	const durationMs = new Date(endTimestamp).getTime() - new Date(startTs).getTime();
	const hash = sha3TruncatedTurn(turnMessages);

	// Count tokens (approximate from assistant messages)
	let tokenCount = 0;
	for (const m of turnMessages) {
		if (m.role === "assistant" && "usage" in m) {
			tokenCount += m.usage?.output ?? 0;
		}
	}

	const turnStart: TurnStartMessage = {
		role: "turnStart",
		turn: state.currentTurn,
		sigil: state.currentSigil,
		nonce: state.currentNonce,
		timestamp: startTs,
		delta: formatDelta(state.previousTurnEndTimestamp, startTs),
	};

	const turnEnd: TurnEndMessage = {
		role: "turnEnd",
		turn: state.currentTurn,
		sigil: state.currentSigil,
		nonce: state.currentNonce,
		hash,
		timestamp: endTimestamp,
		tokenCount: tokenCount > 0 ? tokenCount : undefined,
		durationMs,
	};

	// Update state for next turn
	state.previousTurnEndTimestamp = endTimestamp;
	state.turnStartTimestamp = undefined;
	state.currentSigil = undefined;
	state.currentNonce = undefined;

	return [turnStart, turnEnd];
}

// ============================================================================
// Message Array Manipulation
// ============================================================================

/**
 * Inject turn boundaries around a completed turn in the message array.
 *
 * @param messages - Full message array
 * @param turnStartIndex - Index where the turn's first message starts
 * @param turnEndIndex - Index where the turn's last message ends (exclusive)
 * @param turnStart - TurnStartMessage to inject
 * @param turnEnd - TurnEndMessage to inject
 * @returns New message array with boundaries injected
 */
export function injectTurnBoundaries(
	messages: Message[],
	turnStartIndex: number,
	turnEndIndex: number,
	turnStart: TurnStartMessage,
	turnEnd: TurnEndMessage,
): Message[] {
	const before = messages.slice(0, turnStartIndex);
	const turnContent = messages.slice(turnStartIndex, turnEndIndex);
	const after = messages.slice(turnEndIndex);

	return [...before, turnStart, ...turnContent, turnEnd, ...after];
}

/**
 * Render a TurnStartMessage as bracket text for display.
 * Sigil at far left (outermost position).
 */
export function renderTurnStart(msg: TurnStartMessage): string {
	const deltaStr = msg.delta ? ` │ Δ${msg.delta}` : "";
	return `${msg.sigil} ${msg.nonce} │ turn:${msg.turn} │ T=${msg.timestamp}${deltaStr}`;
}

/**
 * Render a TurnEndMessage as bracket text for display.
 * Sigil at far right (outermost position, mirroring open).
 */
export function renderTurnEnd(msg: TurnEndMessage): string {
	const durationStr = msg.durationMs ? ` │ Δt=${Math.round(msg.durationMs / 1000)}s` : "";
	const tokenStr = msg.tokenCount ? ` │ tokens:${msg.tokenCount}` : "";
	return `H=${msg.hash}${durationStr}${tokenStr} │ ${msg.nonce} ${msg.sigil}`;
}
