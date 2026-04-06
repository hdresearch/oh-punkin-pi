import type { BracketId } from "@oh-my-pi/pi-ai";
import { formatDeltaMs, formatTimestampNYC, generateUserBracketId, sha3Trunc } from "@oh-my-pi/pi-ai/role-boundary";
import { Container, Markdown, Spacer, visibleWidth } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Left-gutter box drawing chars for bracket visual */
const BRACKET_TOP = "┌";
const BRACKET_MID = "│";
const BRACKET_BOT = "└";

interface BracketOptions {
	synthetic?: boolean;
	bracketId?: BracketId;
	timestamp?: number;
	endTimestamp?: number;
	turn?: number;
}

/**
 * Component that renders a user message with left-gutter visual bracket
 * showing sigil, nonce, timestamp, turn, and content hash.
 */
export class UserMessageComponent extends Container {
	#text: string;
	#bracketId: BracketId;
	#timestamp: number | undefined;
	#endTimestamp: number | undefined;
	#turn: number | undefined;

	constructor(text: string, options?: boolean | BracketOptions) {
		super();
		this.#text = text;

		// Support legacy boolean signature: constructor(text, synthetic)
		const opts: BracketOptions = typeof options === "boolean" ? { synthetic: options } : (options ?? {});

		if (!opts.bracketId) {
			// 2026-04-05: bracketId is now generated at every creation site.
			// Missing on new messages means broken wiring — fail loud.
			const MIGRATION_CUTOFF = Date.UTC(2026, 3, 5); // 2026-04-05
			const msgTime = opts.endTimestamp ?? opts.timestamp ?? 0;
			if (msgTime >= MIGRATION_CUTOFF) {
				throw new Error(
					`UserMessageComponent: bracketId missing on message from ${new Date(msgTime).toISOString()}. ` +
						"Every user message must have a bracketId. Check creation site wiring.",
				);
			}
		}
		this.#bracketId = opts.bracketId ?? generateUserBracketId();
		this.#timestamp = opts.timestamp;
		this.#endTimestamp = opts.endTimestamp;
		this.#turn = opts.turn;

		const synthetic = opts.synthetic ?? false;
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, getMarkdownTheme(), {
				bgColor,
				color,
			}),
		);
	}

	override render(width: number): string[] {
		// Gutter takes 2 visible chars ("│ "), reduce content width accordingly
		const GUTTER_WIDTH = 2;
		const lines = super.render(width - GUTTER_WIDTH);
		if (lines.length === 0) {
			return lines;
		}

		const { sigil, nonce } = this.#bracketId;
		const hash = sha3Trunc(this.#text);
		// User messages: green (success) color
		const style = (s: string) => theme.fg("success", s);

		const startTs = this.#timestamp != null ? ` T=${formatTimestampNYC(this.#timestamp)}` : "";
		const turnLabel = this.#turn != null ? ` turn:${this.#turn}` : "";
		const topMeta = `${BRACKET_TOP} ${sigil} ${nonce}${startTs}${turnLabel} `;
		const topDashLen = Math.max(0, width - visibleWidth(topMeta));
		const topLine = style(`${topMeta}${"─".repeat(topDashLen)}`);

		const endTs = this.#endTimestamp != null ? `T=${formatTimestampNYC(this.#endTimestamp)} ` : "";
		const deltaStr =
			this.#timestamp != null && this.#endTimestamp != null && this.#endTimestamp > this.#timestamp
				? `Δ${formatDeltaMs(this.#endTimestamp - this.#timestamp)} `
				: "";
		const botMeta = `${BRACKET_BOT} ${endTs}${deltaStr}H=${hash} ${nonce} ${sigil} `;
		const botDashLen = Math.max(0, width - visibleWidth(botMeta));
		const botLine = style(`${botMeta}${"─".repeat(botDashLen)}`);
		const gutterPrefix = style(`${BRACKET_MID} `);

		const guttered = lines.map(line => gutterPrefix + line);

		const result = [OSC133_ZONE_START + topLine, ...guttered, botLine + OSC133_ZONE_END + OSC133_ZONE_FINAL];
		return result;
	}
}
