/**
 * Role boundary protection via sigil + word nonces + temporal metadata.
 *
 * Pure functions. Four disjoint codebooks:
 *   USER      — natural/elemental words, emoji/bracket sigils
 *   ASSISTANT — craft/tool words, tech emoji sigils
 *   SYSTEM    — infrastructure/plumbing words, box-drawing sigils
 *   SQUIGGLE  — celestial words, geometric sigils
 */

import { createHash, randomBytes } from "crypto";

import type { BracketId } from "./types.js";

// =============================================================================
// Codebooks
// =============================================================================

const USER_SIGILS = [
	"🐉",
	"🐲",
	"🔮",
	"🧿",
	"🌲",
	"🌿",
	"🍃",
	"✨",
	"📜",
	"【",
	"〔",
	"〖",
	"『",
	"《",
	"❮",
	"⟨",
	"⟪",
] as const;

const USER_WORDS = [
	"amber",
	"anchor",
	"anvil",
	"arctic",
	"autumn",
	"beacon",
	"blaze",
	"bloom",
	"boulder",
	"bronze",
	"canyon",
	"cedar",
	"cipher",
	"circuit",
	"citrus",
	"cobalt",
	"copper",
	"coral",
	"cosmos",
	"crystal",
	"drift",
	"dusk",
	"eclipse",
	"ember",
	"falcon",
	"fern",
	"flame",
	"flint",
	"forge",
	"frost",
	"glacier",
	"granite",
	"grove",
	"harbor",
	"hazel",
	"helix",
	"horizon",
	"indigo",
	"iron",
	"ivory",
	"jade",
	"jasper",
	"kelp",
	"lantern",
	"larch",
	"lava",
	"lunar",
	"marble",
	"marsh",
	"meadow",
	"mist",
	"moss",
	"nectar",
	"nova",
	"oak",
	"obsidian",
	"ocean",
	"onyx",
	"orbit",
	"ozone",
	"pebble",
	"pine",
	"plasma",
	"prism",
	"pulse",
	"quartz",
	"rain",
	"reef",
	"ridge",
	"river",
	"rust",
	"sage",
	"salt",
	"sand",
	"scarlet",
	"shadow",
	"silver",
	"slate",
	"solar",
	"spark",
	"spruce",
	"steel",
	"stone",
	"storm",
	"summit",
	"thorn",
	"thunder",
	"tide",
	"timber",
	"torch",
	"vapor",
	"velvet",
	"vertex",
	"violet",
	"vortex",
	"wave",
	"willow",
	"zinc",
	"zephyr",
] as const;

const ASSISTANT_SIGILS = [
	"🤖",
	"💾",
	"📟",
	"🕹️",
	"💽",
	"🖨️",
	"📠",
	"🔌",
	"🧲",
	"📡",
	"🛸",
	"🎰",
	"📺",
	"💿",
	"🔋",
	"⌨️",
	"🖲️",
	"📼",
	"🗜️",
	"💡",
] as const;

const ASSISTANT_WORDS = [
	"adze",
	"awl",
	"bevel",
	"bobbin",
	"braid",
	"burnish",
	"chamfer",
	"chisel",
	"clamp",
	"collet",
	"dowel",
	"ferrule",
	"froe",
	"gauge",
	"gimlet",
	"gouge",
	"grommet",
	"gudgeon",
	"hinge",
	"jig",
	"joggle",
	"kerf",
	"lathe",
	"level",
	"loom",
	"mallet",
	"mitre",
	"mortise",
	"needle",
	"nock",
	"pawl",
	"pattern",
	"plane",
	"plumb",
	"rabbet",
	"rasp",
	"rivet",
	"router",
	"scribe",
	"seam",
	"shim",
	"shuttle",
	"spindle",
	"splice",
	"spool",
	"sprocket",
	"stitch",
	"swage",
	"tack",
	"tang",
	"tenon",
	"thread",
	"trowel",
	"trunnion",
	"vice",
	"warp",
	"weft",
	"wedge",
	"weld",
	"whorl",
	"wimble",
	"yoke",
	"zarf",
	"bellows",
	"bodkin",
	"brad",
	"burr",
	"calipers",
	"chuck",
	"die",
	"drill",
	"file",
	"flange",
	"graver",
	"hacksaw",
	"hammer",
	"hasp",
	"jack",
	"knife",
	"mandrel",
	"maul",
	"nipper",
	"oilstone",
	"peen",
	"pinion",
	"press",
	"punch",
	"ratchet",
	"reamer",
	"sander",
	"saw",
	"snips",
	"socket",
	"square",
	"staple",
	"tap",
	"template",
	"tin",
	"torque",
	"vise",
] as const;

const SQUIGGLE_SIGILS = [
	"◈",
	"◇",
	"◆",
	"⬡",
	"⬢",
	"△",
	"▽",
	"☆",
	"★",
	"⚝",
	"✧",
	"✦",
	"⋄",
	"⟐",
	"⧫",
	"⬖",
	"⬗",
	"⬘",
	"⬙",
] as const;

const SQUIGGLE_WORDS = [
	"aphelion",
	"apogee",
	"asterism",
	"azimuth",
	"binary",
	"bolide",
	"celestial",
	"chromosphere",
	"circumpolar",
	"conjunction",
	"corona",
	"crescent",
	"culmination",
	"declination",
	"doppler",
	"ecliptic",
	"ephemeris",
	"equinox",
	"firmament",
	"galactic",
	"gibbous",
	"heliacal",
	"inclination",
	"jovian",
	"kepler",
	"libration",
	"limb",
	"lunation",
	"magnitude",
	"meridian",
	"nadir",
	"nebula",
	"node",
	"nutation",
	"occultation",
	"opposition",
	"parallax",
	"parsec",
	"penumbra",
	"perigee",
	"perihelion",
	"photosphere",
	"planisphere",
	"precession",
	"pulsar",
	"quadrature",
	"quasar",
	"radiant",
	"redshift",
	"retrograde",
	"saros",
	"sidereal",
	"solstice",
	"spectra",
	"syzygy",
	"terminator",
	"transit",
	"umbra",
	"zenith",
	"zodiacal",
] as const;

const SYSTEM_SIGILS = ["⊞", "⊟", "⊠", "⊡", "▦", "▧", "▨", "▩", "▪", "▫", "◻", "◼", "◽", "◾", "⬜", "⬛"] as const;

const SYSTEM_WORDS = [
	"buffer",
	"cache",
	"channel",
	"chunk",
	"cursor",
	"digest",
	"epoch",
	"fence",
	"frame",
	"gate",
	"handle",
	"header",
	"heap",
	"index",
	"journal",
	"latch",
	"ledger",
	"log",
	"mux",
	"offset",
	"packet",
	"page",
	"pipe",
	"pool",
	"proxy",
	"queue",
	"record",
	"relay",
	"ring",
	"route",
	"schema",
	"sector",
	"segment",
	"shard",
	"signal",
	"slab",
	"slot",
	"snapshot",
	"span",
	"stack",
	"store",
	"stripe",
	"stub",
	"swap",
	"sync",
	"table",
	"tag",
	"ticket",
	"tier",
	"token",
	"trace",
	"trunk",
	"tuple",
	"vault",
	"vector",
	"volume",
	"wire",
] as const;

const TOOL_RESULT_SIGILS = [
	"🔧",
	"🔨",
	"⛏️",
	"🪚",
	"🪛",
	"🔩",
	"⚒️",
	"🛠️",
	"⚙️",
	"🪝",
	"🪜",
	"🪤",
	"🪓",
	"🔗",
	"⛓️",
	"🪵",
	"🧰",
	"📎",
	"🔑",
] as const;

const TOOL_RESULT_WORDS = [
	// rheology
	"creep",
	"shear",
	"viscous",
	"thixo",
	"yield",
	"strain",
	"stress",
	"modulus",
	"newtonian",
	"bingham",
	"laminar",
	"turbid",
	"dilatant",
	"slurry",
	"emulsion",
	"colloid",
	// crystallography
	"lattice",
	"anneal",
	"nucleate",
	"dendrite",
	"alloy",
	"austenite",
	"ferrite",
	"martensite",
	"pearlite",
	"bainite",
	"cementite",
	"twinning",
	"disloc",
	"grain",
	"phase",
	"precipitate",
	// polymer / soft matter
	"polymer",
	"monomer",
	"crosslink",
	"elastomer",
	"thermoset",
	"resin",
	"vulcan",
	"plasticize",
	"gel",
	"latex",
	"silicone",
	"epoxy",
	// tribology / surface
	"friction",
	"abrasion",
	"adhesion",
	"fatigue",
	"erosion",
	"patina",
	"oxide",
	"galvanic",
	"anodize",
	"temper",
	"quench",
	"sinter",
	// bulk properties
	"tensile",
	"ductile",
	"brittle",
	"malleable",
	"hardness",
	"toughness",
	"fracture",
	"cleavage",
	"isotropy",
	"hygro",
	"porosity",
	"density",
	// processing
	"extrude",
	"laminate",
	"sputter",
	"ablate",
	"flux",
	"crucible",
	"ingot",
	"slag",
	"matte",
	"calcine",
	"leach",
	"refine",
] as const;

// =============================================================================
// Helpers
// =============================================================================

function pick<T>(arr: readonly T[]): T {
	const entropy = randomBytes(2);
	return arr[entropy.readUInt16BE(0) % arr.length];
}

function generateNonce(words: readonly string[]): string {
	return `${pick(words)}-${pick(words)}-${pick(words)}`;
}

export function sha3Trunc(content: string): string {
	return createHash("sha3-256").update(content).digest("hex").slice(0, 12);
}

const NYC_FORMAT = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
	fractionalSecondDigits: 3,
});

/** Format ms-since-epoch as full ISO 8601 in America/New_York. */
export function formatTimestamp(ms: number): string {
	const parts = NYC_FORMAT.formatToParts(new Date(ms));
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";

	const year = get("year");
	const month = get("month");
	const day = get("day");
	const hour = get("hour");
	const minute = get("minute");
	const second = get("second");
	const frac = get("fractionalSecond");

	// Compute UTC offset for America/New_York at this instant
	const d = new Date(ms);
	const utcMs = d.getTime() + d.getTimezoneOffset() * 60_000;
	const nycMs = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" })).getTime();
	const offsetMin = (nycMs - utcMs) / 60_000;
	const offsetSign = offsetMin >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMin);
	const offsetH = String(Math.floor(absOffset / 60)).padStart(2, "0");
	const offsetM = String(absOffset % 60).padStart(2, "0");

	return `${year}-${month}-${day}T${hour}:${minute}:${second}.${frac}${offsetSign}${offsetH}:${offsetM}`;
}

/** Format ms-since-epoch as short timestamp with NYC suffix for TUI display. */
export function formatTimestampNYC(ms: number): string {
	const parts = NYC_FORMAT.formatToParts(new Date(ms));
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")} NYC`;
}

/** Format a duration in ms as a human-readable delta string. */
export function formatDeltaMs(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	if (sec < 300) {
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return `${m}m${s}s`;
	}
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return m > 0 ? `${h}h${m}m` : `${h}h`;
}

// =============================================================================
// Wrap Functions
// =============================================================================

export interface WrapParams {
	/** Message timestamp (ms since epoch). */
	timestamp: number;
	/** End/submit timestamp (ms since epoch). Same as timestamp if unknown. */
	endTimestamp: number;
	/** 1-indexed turn number. */
	turn: number;
	/** Optional inter-turn gap descriptor, e.g. "2m", "13s". */
	delta?: string;
}

/**
 * Wrap user content with role boundary.
 * Format: [user]{sigil nonce T=... turn:N Δ... { content } T=end H=hash nonce sigil}
 */
export function wrapUser(content: string, params: WrapParams, bracketId?: BracketId): string {
	const s = bracketId?.sigil ?? pick(USER_SIGILS);
	const n = bracketId?.nonce ?? generateNonce(USER_WORDS);
	const hash = sha3Trunc(content);
	const delta = params.delta ? ` Δ${params.delta}` : "";
	const tStart = formatTimestamp(params.timestamp);
	const tEnd = formatTimestamp(params.endTimestamp);

	return `[user]{${s} ${n} T=${tStart} turn:${params.turn}${delta} {\n${content}\n} T=${tEnd} H=${hash} ${n} ${s}}`;
}

/**
 * Wrap assistant content with role boundary.
 * Not wired into convertToLlm yet — echoing risk in multi-turn settings.
 */
export function wrapAssistant(content: string, params: WrapParams): string {
	const s = pick(ASSISTANT_SIGILS);
	const n = generateNonce(ASSISTANT_WORDS);
	const hash = sha3Trunc(content);
	const delta = params.delta ? ` Δ${params.delta}` : "";
	const tStart = formatTimestamp(params.timestamp);
	const tEnd = formatTimestamp(params.endTimestamp);

	return `[assistant]{${s} ${n} T=${tStart} turn:${params.turn}${delta} {\n${content}\n} T=${tEnd} H=${hash} ${n} ${s}}`;
}

/**
 * Wrap system-injected content (file mentions, summaries, etc.) with role boundary.
 * Format: [system]{sigil nonce T=... turn:N { content } T=end H=hash nonce sigil}
 */
export function wrapSystem(content: string, params: WrapParams, bracketId?: BracketId): string {
	const s = bracketId?.sigil ?? pick(SYSTEM_SIGILS);
	const n = bracketId?.nonce ?? generateNonce(SYSTEM_WORDS);
	const hash = sha3Trunc(content);
	const delta = params.delta ? ` Δ${params.delta}` : "";
	const tStart = formatTimestamp(params.timestamp);
	const tEnd = formatTimestamp(params.endTimestamp);

	return `[system]{${s} ${n} T=${tStart} turn:${params.turn}${delta} {\n${content}\n} T=${tEnd} H=${hash} ${n} ${s}}`;
}

/**
 * Wrap tool-result content with role boundary.
 * Format: [tool-result]{sigil nonce T=... turn:N tool:name { content } T=end H=hash nonce sigil}
 */
export interface ToolResultWrapParams extends WrapParams {
	/** Tool name that produced this result. */
	toolName: string;
}

export function wrapToolResult(content: string, params: ToolResultWrapParams, bracketId?: BracketId): string {
	const s = bracketId?.sigil ?? pick(TOOL_RESULT_SIGILS);
	const n = bracketId?.nonce ?? generateNonce(TOOL_RESULT_WORDS);
	const hash = sha3Trunc(content);
	const delta = params.delta ? ` Δ${params.delta}` : "";
	const tStart = formatTimestamp(params.timestamp);
	const tEnd = formatTimestamp(params.endTimestamp);

	return `[tool-result]{${s} ${n} T=${tStart} turn:${params.turn} tool:${params.toolName}${delta} {\n${content}\n} T=${tEnd} H=${hash} ${n} ${s}}`;
}

// =============================================================================
// Bracket ID Generators
// =============================================================================

/** Generate a BracketId for a user message. */
export function generateUserBracketId(): BracketId {
	return { sigil: pick(USER_SIGILS), nonce: generateNonce(USER_WORDS) };
}

/** Generate a BracketId for a tool result message. */
export function generateToolResultBracketId(): BracketId {
	return { sigil: pick(TOOL_RESULT_SIGILS), nonce: generateNonce(TOOL_RESULT_WORDS) };
}

/** Generate a BracketId for a system message. */
export function generateSystemBracketId(): BracketId {
	return { sigil: pick(SYSTEM_SIGILS), nonce: generateNonce(SYSTEM_WORDS) };
}

// =============================================================================
// Squiggle Bracket Helpers
// =============================================================================

/** Generate an opening squiggle marker with sigil + nonce. */
export function openSquiggleBracket(): { marker: string; bracketId: BracketId } {
	const sigil = pick(SQUIGGLE_SIGILS);
	const n = generateNonce(SQUIGGLE_WORDS);
	return {
		marker: `${sigil} ${n} {`,
		bracketId: { sigil, nonce: n },
	};
}

/** Generate a closing squiggle marker matching a given bracketId. */
export function closeSquiggleBracket(bracketId: BracketId): string {
	return `} ${bracketId.nonce} ${bracketId.sigil}`;
}

/**
 * Generate a deterministic opening squiggle marker seeded from content hash.
 * Same content always produces the same sigil + nonce, avoiding cache busting
 * when convertToLlm reifies thinking blocks on every call.
 */
export function openSquiggleBracketDeterministic(content: string): { marker: string; bracketId: BracketId } {
	const hash = createHash("sha3-256").update(content).digest();
	// Use different byte ranges to avoid correlated indices
	const sigil = SQUIGGLE_SIGILS[hash.readUInt16BE(0) % SQUIGGLE_SIGILS.length];
	const w1 = SQUIGGLE_WORDS[hash.readUInt16BE(2) % SQUIGGLE_WORDS.length];
	const w2 = SQUIGGLE_WORDS[hash.readUInt16BE(4) % SQUIGGLE_WORDS.length];
	const w3 = SQUIGGLE_WORDS[hash.readUInt16BE(6) % SQUIGGLE_WORDS.length];
	const n = `${w1}-${w2}-${w3}`;
	return {
		marker: `${sigil} ${n} {`,
		bracketId: { sigil, nonce: n },
	};
}

// =============================================================================
// Codebook Access
// =============================================================================

export const USER_CODEBOOK = { sigils: USER_SIGILS, words: USER_WORDS } as const;
export const ASSISTANT_CODEBOOK = { sigils: ASSISTANT_SIGILS, words: ASSISTANT_WORDS } as const;
export const SYSTEM_CODEBOOK = { sigils: SYSTEM_SIGILS, words: SYSTEM_WORDS } as const;
export const SQUIGGLE_CODEBOOK = { sigils: SQUIGGLE_SIGILS, words: SQUIGGLE_WORDS } as const;
export const TOOL_RESULT_CODEBOOK = { sigils: TOOL_RESULT_SIGILS, words: TOOL_RESULT_WORDS } as const;
