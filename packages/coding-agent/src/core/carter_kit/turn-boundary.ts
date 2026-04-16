/**
 * CarterKit Turn Boundary — injection of TurnStartMessage / TurnEndMessage.
 *
 * Turn boundaries demarcate assistant turns structurally while keeping the
 * underlying conversation content unchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { formatTimestamp } from "@oh-my-pi/pi-ai/role-boundary";

// ============================================================================
// Local type definitions (avoid circular imports with session/messages.ts)
// ============================================================================

type Timestamp = number; // epoch ms in opp's AgentMessage representation
function now(): Timestamp {
	return Date.now();
}

// ============================================================================
// Turn boundary message types (match declaration merging in messages.ts)
// ============================================================================

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

// ============================================================================
// Sigil and Nonce Generation
// ============================================================================

const SIGILS = [
	"🐉",
	"🐲",
	"🔮",
	"🧿",
	"🌲",
	"🌿",
	"🍃",
	"✨",
	"📜",
	"〰",
	"❮",
	"⟨",
	"⟪",
	"『",
	"《",
	"【",
	"〖",
	"⌊",
	"«",
	"⸘",
];

const NONCE_WORDS = [
	// Nature
	"oak",
	"pine",
	"cedar",
	"willow",
	"birch",
	"maple",
	"ash",
	"elm",
	"hazel",
	"rowan",
	"frost",
	"ember",
	"storm",
	"tide",
	"wave",
	"reef",
	"grove",
	"vale",
	"peak",
	"ridge",
	// Materials
	"iron",
	"steel",
	"bronze",
	"copper",
	"silver",
	"gold",
	"jade",
	"amber",
	"coral",
	"pearl",
	"slate",
	"granite",
	"marble",
	"obsidian",
	"quartz",
	"crystal",
	"onyx",
	"opal",
	"ruby",
	"sapphire",
	// Abstract
	"echo",
	"pulse",
	"drift",
	"flux",
	"vortex",
	"helix",
	"prism",
	"nexus",
	"arc",
	"span",
	"dusk",
	"dawn",
	"noon",
	"night",
	"solar",
	"lunar",
	"stellar",
	"cosmic",
	"void",
	"ether",
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

function sha3TruncatedTurn(messages: readonly AgentMessage[]): string {
	const content = messages
		.map(m => {
			if (m.role === "assistant") {
				return m.content
					.map(c => {
						if (c.type === "text") return c.text;
						if (c.type === "thinking") return c.thinking;
						if (c.type === "toolCall") return `${c.name}(${JSON.stringify(c.arguments)})`;
						return "";
					})
					.join("");
			}
			if (m.role === "toolResult") {
				return m.content.map(c => (c.type === "text" ? c.text : "")).join("");
			}
			return "";
		})
		.join("\n");

	const hash = createHash("sha3-256").update(content).digest("hex");
	return hash.slice(0, 12);
}

function formatDelta(fromTs: Timestamp | undefined, toTs: Timestamp): string | undefined {
	if (!fromTs) return undefined;
	const diffMs = toTs - fromTs;
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
 * Materialize the current turn-start marker from state, if a turn is open.
 */
export function currentTurnStartMessage(state: TurnBoundaryState): TurnStartMessage | undefined {
	if (!state.turnStartTimestamp || !state.currentSigil || !state.currentNonce) {
		return undefined;
	}

	return {
		role: "turnStart",
		turn: state.currentTurn,
		sigil: state.currentSigil,
		nonce: state.currentNonce,
		timestamp: state.turnStartTimestamp,
		delta: formatDelta(state.previousTurnEndTimestamp, state.turnStartTimestamp),
	};
}

/**
 * Called when an assistant turn completes.
 * Creates TurnStartMessage and TurnEndMessage to wrap the turn's messages.
 */
export function onTurnEnd(
	state: TurnBoundaryState,
	turnMessages: readonly AgentMessage[],
): [TurnStartMessage, TurnEndMessage] {
	const endTimestamp = now();

	if (!state.turnStartTimestamp || !state.currentSigil || !state.currentNonce) {
		state.turnStartTimestamp = endTimestamp;
		state.currentSigil = randomSigil();
		state.currentNonce = randomNonce();
	}

	const startTs = state.turnStartTimestamp;
	const durationMs = endTimestamp - startTs;
	const hash = sha3TruncatedTurn(turnMessages);

	let tokenCount = 0;
	for (const m of turnMessages) {
		if (m.role === "assistant" && "usage" in m) {
			tokenCount += (m as { usage?: { output?: number } }).usage?.output ?? 0;
		}
	}

	const isEmpty = !turnMessages.some(m => {
		if (m.role !== "assistant") return false;
		return m.content.length > 0;
	});

	const turnStart = currentTurnStartMessage(state) ?? {
		role: "turnStart" as const,
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
		...(isEmpty ? { isEmpty: true } : {}),
	};

	state.previousTurnEndTimestamp = endTimestamp;
	state.turnStartTimestamp = undefined;
	state.currentSigil = undefined;
	state.currentNonce = undefined;

	return [turnStart, turnEnd];
}

// ============================================================================
// Message Array Manipulation
// ============================================================================

export function injectTurnBoundaries(
	messages: AgentMessage[],
	turnStartIndex: number,
	turnEndIndex: number,
	turnStart: TurnStartMessage,
	turnEnd: TurnEndMessage,
): AgentMessage[] {
	const before = messages.slice(0, turnStartIndex);
	const turnContent = messages.slice(turnStartIndex, turnEndIndex);
	const after = messages.slice(turnEndIndex);

	return [
		...before,
		turnStart as unknown as AgentMessage,
		...turnContent,
		turnEnd as unknown as AgentMessage,
		...after,
	];
}

/**
 * Render a TurnStartMessage as bracket text for display.
 */
export function renderTurnStart(msg: TurnStartMessage): string {
	const deltaStr = msg.delta ? ` │ Δ${msg.delta}` : "";
	return `${msg.sigil} ${msg.nonce} │ turn:${msg.turn} │ T=${formatTimestamp(msg.timestamp)}${deltaStr}`;
}

/**
 * Render a TurnEndMessage as bracket text for display.
 */
export function renderTurnEnd(msg: TurnEndMessage): string {
	const durationStr = msg.durationMs ? ` │ Δt=${Math.round(msg.durationMs / 1000)}s` : "";
	const tokenStr = msg.tokenCount ? ` │ tokens:${msg.tokenCount}` : "";
	const emptyStr = msg.isEmpty ? ` │ (empty)` : "";
	return `H=${msg.hash}${durationStr}${tokenStr}${emptyStr} │ ${msg.nonce} ${msg.sigil}`;
}
