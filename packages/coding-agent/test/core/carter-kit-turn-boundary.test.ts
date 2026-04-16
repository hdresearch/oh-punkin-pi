import { describe, expect, it } from "bun:test";
import { formatTimestamp } from "@oh-my-pi/pi-ai/role-boundary";
import { renderTurnStart, type TurnStartMessage } from "@oh-my-pi/pi-coding-agent/core/carter_kit/turn-boundary";

describe("CarterKit turn boundary timestamps", () => {
	it("formats spring timestamps in NYC with a numeric offset", () => {
		const ts = Date.parse("2026-04-10T20:57:08.789Z");
		expect(formatTimestamp(ts)).toBe("2026-04-10T16:57:08.789-04:00");
	});

	it("formats winter timestamps in NYC with EST offset", () => {
		const ts = Date.parse("2026-01-10T20:57:08.789Z");
		expect(formatTimestamp(ts)).toBe("2026-01-10T15:57:08.789-05:00");
	});

	it("renders turn-start brackets with the shared NYC timestamp formatter", () => {
		const ts = Date.parse("2026-04-10T20:57:08.789Z");
		const msg: TurnStartMessage = {
			role: "turnStart",
			turn: 3,
			sigil: "🍃",
			nonce: "copper-drift-spruce",
			timestamp: ts,
			delta: "31s",
		};

		expect(renderTurnStart(msg)).toBe("🍃 copper-drift-spruce │ turn:3 │ T=2026-04-10T16:57:08.789-04:00 │ Δ31s");
	});
});
