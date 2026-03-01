/**
 * Squiggle boundary tools for visible reasoning.
 *
 * These tools let the model explicitly mark reasoning block boundaries,
 * providing structured signals with timestamps, turn tracking, and integrity hashes.
 *
 * Uses codebooks from role-boundary.ts:
 * - USER_CODEBOOK: matches user message wrapping (for continuity)
 * - SQUIGGLE_CODEBOOK: disjoint pool for squiggle-specific markers
 */

import { createHash, randomBytes } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@punkin-pi/agent-core";
import { SQUIGGLE_CODEBOOK, USER_CODEBOOK } from "@punkin-pi/ai";
import { Type } from "@sinclair/typebox";

// Markers picked at start of each squiggle block
interface SquiggleMarkers {
	userSigil: string;
	squiggleSigil: string;
	userNonce: string;
	squiggleNonce: string;
}

// Session state for squiggle tracking
interface SquiggleState {
	turn: number;
	lastEndTime: number | null;
	currentMarkers: SquiggleMarkers | null;
	currentStartTime: number | null;
	sessionStartTime: number;
}

// Global state (reset per session via createSquiggleTools)
let state: SquiggleState = {
	turn: 0,
	lastEndTime: null,
	currentMarkers: null,
	currentStartTime: null,
	sessionStartTime: Date.now(),
};

/**
 * Format duration in human-readable form.
 */
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

/**
 * Get NYC timestamp with zone bracket.
 */
function nycTimestamp(): { full: string; short: string; zone: string } {
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

	const full = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
	const short = `${get("hour")}:${get("minute")}:${get("second")}`;

	// Determine if EST or EDT
	const jan = new Date(now.getFullYear(), 0, 1);
	const jul = new Date(now.getFullYear(), 6, 1);
	const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
	const nyOffset = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getTimezoneOffset();
	const isDST = nyOffset < stdOffset;
	const zone = isDST ? "EDT/-04:00" : "EST/-05:00";

	return { full, short, zone };
}

/**
 * SHA3-256 truncated to 12 hex chars.
 */
function sha3Trunc(content: string): string {
	return createHash("sha3-256").update(content).digest("hex").slice(0, 12);
}

/**
 * Pick random element from array using crypto randomness.
 */
function pick<T>(arr: readonly T[]): T {
	const entropy = randomBytes(2);
	return arr[entropy.readUInt16BE(0) % arr.length];
}

/**
 * Generate word nonce from codebook.
 */
function nonce(words: readonly string[]): string {
	return `${pick(words)}-${pick(words)}-${pick(words)}`;
}

/**
 * Pick sigils and nonces from both codebooks.
 * Returns user sigil (for continuity) + squiggle sigil (disjoint marker) + nonces.
 */
function pickMarkers(): { userSigil: string; squiggleSigil: string; userNonce: string; squiggleNonce: string } {
	return {
		userSigil: pick(USER_CODEBOOK.sigils),
		squiggleSigil: pick(SQUIGGLE_CODEBOOK.sigils),
		userNonce: nonce(USER_CODEBOOK.words),
		squiggleNonce: nonce(SQUIGGLE_CODEBOOK.words),
	};
}

// Tool schemas
const startSquiggleSchema = Type.Object({});
const endSquiggleSchema = Type.Object({
	content: Type.String({ description: "The reasoning content between start and end (for integrity hash)" }),
});

export interface StartSquiggleDetails {
	turn: number;
	openTag: string;
	timestamp: string;
	delta?: string;
	convAge: string;
	markers: SquiggleMarkers;
}

export interface EndSquiggleDetails {
	closeTag: string;
	timestamp: string;
	hash: string;
	duration: string;
}

/**
 * Start squiggle tool - marks beginning of visible reasoning block.
 *
 * Format: {userSigil} {squiggleSigil} {userNonce} {squiggleNonce} T=... turn:N Δ... {
 */
export const startSquiggleTool: AgentTool<typeof startSquiggleSchema, StartSquiggleDetails> = {
	name: "start_squiggle",
	label: "Start Squiggle",
	description:
		"Start a visible reasoning block. Returns the opening tag with timestamp, turn number, and sigils from both user and squiggle codebooks. Call this before writing reasoning content.",
	parameters: startSquiggleSchema,
	execute: async (): Promise<AgentToolResult<StartSquiggleDetails>> => {
		const now = Date.now();
		state.turn++;
		state.currentMarkers = pickMarkers();
		state.currentStartTime = now;

		const ts = nycTimestamp();
		const delta = state.lastEndTime ? formatDuration(now - state.lastEndTime) : undefined;
		const convAge = formatDuration(now - state.sessionStartTime);
		const m = state.currentMarkers;

		// Format: {userSigil} {squiggleSigil} {userNonce} {squiggleNonce} T=... turn:N Δ... {
		const openTag = `${m.userSigil} ${m.squiggleSigil} ${m.userNonce} ${m.squiggleNonce} T=${ts.full} [NYC=${ts.zone}] turn:${state.turn}${delta ? ` Δ${delta}` : ""} {`;

		const details: StartSquiggleDetails = {
			turn: state.turn,
			openTag,
			timestamp: `${ts.full} [NYC=${ts.zone}]`,
			delta,
			convAge,
			markers: m,
		};

		return {
			content: [
				{
					type: "text",
					text: `${openTag}\n\nturn:${state.turn} | conv:${convAge}${delta ? ` | Δ${delta}` : ""}`,
				},
			],
			details,
		};
	},
};

/**
 * End squiggle tool - marks end of visible reasoning block with integrity hash.
 *
 * Format: } T=... H=... Δc=... {squiggleNonce} {userNonce} {squiggleSigil} {userSigil}
 */
export const endSquiggleTool: AgentTool<typeof endSquiggleSchema, EndSquiggleDetails> = {
	name: "end_squiggle",
	label: "End Squiggle",
	description:
		"End a visible reasoning block. Pass the reasoning content written between start_squiggle and this call. Returns the closing tag with timestamp, integrity hash, and cognition duration.",
	parameters: endSquiggleSchema,
	execute: async (_toolCallId, args): Promise<AgentToolResult<EndSquiggleDetails>> => {
		const now = Date.now();
		const ts = nycTimestamp();
		const hash = sha3Trunc(args.content);

		const duration = state.currentStartTime ? formatDuration(now - state.currentStartTime) : "0s";

		const m = state.currentMarkers || pickMarkers();
		// Mirror format: } T=... H=... Δc=... {squiggleNonce} {userNonce} {squiggleSigil} {userSigil}
		const closeTag = `} T=${ts.short} H=${hash} Δc=${duration} ${m.squiggleNonce} ${m.userNonce} ${m.squiggleSigil} ${m.userSigil}`;

		state.lastEndTime = now;
		state.currentStartTime = null;

		const details: EndSquiggleDetails = {
			closeTag,
			timestamp: ts.short,
			hash,
			duration,
		};

		return {
			content: [{ type: "text", text: closeTag }],
			details,
		};
	},
};

/**
 * Create fresh squiggle tools with reset state.
 * Call this when starting a new session.
 */
export function createSquiggleTools(): [typeof startSquiggleTool, typeof endSquiggleTool] {
	state = {
		turn: 0,
		lastEndTime: null,
		currentMarkers: null,
		currentStartTime: null,
		sessionStartTime: Date.now(),
	};
	return [startSquiggleTool, endSquiggleTool];
}

export const squiggleTools = [startSquiggleTool, endSquiggleTool];
