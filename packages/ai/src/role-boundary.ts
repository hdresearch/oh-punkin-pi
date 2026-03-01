/**
 * Role boundary protection via sigil + word nonces + temporal metadata.
 *
 * Pure functions. Uses Timestamp from types.ts.
 */

import { createHash, randomBytes } from "crypto";
import type { Timestamp } from "./types.js";

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
	"umbra",
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

// Squiggle sigils - disjoint from USER and ASSISTANT pools
// These are for model's visible reasoning blocks
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

// Squiggle words - disjoint from USER and ASSISTANT pools
// Astronomical/celestial theme (distinct from natural/tool themes)
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

// =============================================================================
// Helpers
// =============================================================================

function pick<T>(arr: readonly T[]): T {
	const entropy = randomBytes(2);
	return arr[entropy.readUInt16BE(0) % arr.length];
}

function nonce(words: readonly string[]): string {
	return `${pick(words)}-${pick(words)}-${pick(words)}`;
}

function sha3Trunc(content: string): string {
	return createHash("sha3-256").update(content).digest("hex").slice(0, 12);
}

/** Extract just time portion from Timestamp: "2026-02-24T00:23:28-05:00" -> "00:23:28" */
function timeOnly(ts: Timestamp): string {
	const match = ts.match(/T(\d{2}:\d{2}:\d{2})/);
	return match ? match[1] : ts;
}

// =============================================================================
// Wrap Functions
// =============================================================================

export interface WrapParams {
	timestamp: Timestamp;
	endTimestamp: Timestamp;
	turn: number;
	delta?: string; // "2m", "13s", etc. — optional inter-turn gap
}

/**
 * Wrap user content with boundary.
 * Format: <user sigil="..." nonce="..." t="..." turn="N" delta="..." h="...">content</user>
 */
export function wrapUser(content: string, params: WrapParams): string {
	const s = pick(USER_SIGILS);
	const n = nonce(USER_WORDS);
	const hash = sha3Trunc(content);
	const deltaAttr = params.delta ? ` delta="${params.delta}"` : "";

	return `<user sigil="${s}" nonce="${n}" t="${params.timestamp}" turn="${params.turn}"${deltaAttr} h="${hash}">\n${content}\n</user>`;
}

/**
 * Wrap assistant content with boundary.
 * Format: <assistant sigil="..." nonce="..." t="..." turn="N" delta="..." h="...">content</assistant>
 */
export function wrapAssistant(content: string, params: WrapParams): string {
	const s = pick(ASSISTANT_SIGILS);
	const n = nonce(ASSISTANT_WORDS);
	const hash = sha3Trunc(content);
	const deltaAttr = params.delta ? ` delta="${params.delta}"` : "";

	return `<assistant sigil="${s}" nonce="${n}" t="${params.timestamp}" turn="${params.turn}"${deltaAttr} h="${hash}">\n${content}\n</assistant>`;
}

// =============================================================================
// Codebook Access
// =============================================================================

export const USER_CODEBOOK = { sigils: USER_SIGILS, words: USER_WORDS } as const;
export const ASSISTANT_CODEBOOK = { sigils: ASSISTANT_SIGILS, words: ASSISTANT_WORDS } as const;
export const SQUIGGLE_CODEBOOK = { sigils: SQUIGGLE_SIGILS, words: SQUIGGLE_WORDS } as const;
