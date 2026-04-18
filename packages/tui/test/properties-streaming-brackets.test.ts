/**
 * Property-style test for live-streaming bracket glyphs in the TUI transcript.
 *
 * Exercises commit 587428b87 in streaming mode: the absolute-CUP + single-sync-block
 * changes must produce a viewport that converges to a fresh render after N incremental
 * appends. Any residual hardwareCursorRow drift would cause lines to land on wrong
 * screen rows during streaming. Also exercises the
 * `firstChanged < previousContentViewportTop` clamp branch added in commit 8ea43b673
 * (mutation of an off-viewport bracket line).
 *
 * Context: Carter reported "dropped brackets in another session". Live turn-bracket
 * rendering was introduced in 11240ba9d + d3de81a6f. A regression in cursor/viewport
 * bookkeeping manifests as missing or duplicated bracket rows.
 */

import { describe, expect, it } from "bun:test";
import {
	freshRender,
	Harness,
	MarkerFocusableComponent,
	mulberry32,
	pickInt,
	snapshotTerminal,
} from "./properties/harness";

const GLYPHS = ["╭────", "│ hello", "│ world", "├────", "│ reply", "╰────"];

interface Scenario {
	cols: number;
	rows: number;
	finalLines: string[];
	steps: string[][]; // snapshot of lines at each setLines call
}

function pickGlyph(rng: () => number): string {
	const g = GLYPHS[pickInt(rng, 0, GLYPHS.length - 1)];
	if (!g) throw new Error("unreachable: GLYPHS non-empty");
	return g;
}

function genScenario(seed: number): Scenario {
	const rng = mulberry32(seed);
	const cols = pickInt(rng, 20, 60);
	const rows = pickInt(rng, 6, 12);
	const N = pickInt(rng, 5, 30);
	const glyphs: string[] = [];
	for (let i = 0; i < N; i++) glyphs.push(pickGlyph(rng));
	const steps: string[][] = [];
	for (let i = 1; i <= N; i++) {
		// Append step.
		steps.push(glyphs.slice(0, i));
		// p=0.2: idempotent re-render of the same prefix (edit-finalization simulation).
		if (rng() < 0.2) steps.push(glyphs.slice(0, i));
		// p=0.15: mutate a previously-emitted bracket at index j<i to another glyph.
		if (rng() < 0.15 && i > 1) {
			const j = pickInt(rng, 0, i - 1);
			glyphs[j] = pickGlyph(rng);
			steps.push(glyphs.slice(0, i));
		}
	}
	return { cols, rows, finalLines: [...glyphs], steps };
}

async function runStreaming(s: Scenario) {
	const h = new Harness(s.cols, s.rows);
	const component = new MarkerFocusableComponent([]);
	h.tui.addChild(component);
	h.start();
	await h.settle();
	for (const lines of s.steps) {
		component.setLines(lines);
		h.tui.requestRender();
		await h.settle();
	}
	const snap = snapshotTerminal(h.term);
	h.stop();
	return snap;
}

function countOccurrences(lines: string[], needle: string): number {
	let total = 0;
	for (const l of lines) {
		let idx = 0;
		while (true) {
			const k = l.indexOf(needle, idx);
			if (k < 0) break;
			total++;
			idx = k + needle.length;
		}
	}
	return total;
}

async function assertConverges(s: Scenario, label: string | number): Promise<void> {
	const streamed = await runStreaming(s);
	const oracle = await freshRender(s.cols, s.rows, h => {
		const c = new MarkerFocusableComponent([...s.finalLines]);
		h.tui.addChild(c);
	});

	const equal =
		streamed.viewport.length === oracle.viewport.length &&
		streamed.viewport.every((l, i) => l === oracle.viewport[i]);

	if (!equal) {
		console.error("[streaming-brackets] label=", label);
		console.error("cols/rows:", s.cols, s.rows, "N=", s.finalLines.length);
		console.error("final logical lines:", s.finalLines);
		console.error("oracle viewport:", oracle.viewport);
		console.error("stream viewport:", streamed.viewport);
		const diff: string[] = [];
		const maxLen = Math.max(streamed.viewport.length, oracle.viewport.length);
		for (let i = 0; i < maxLen; i++) {
			const o = oracle.viewport[i] ?? "";
			const v = streamed.viewport[i] ?? "";
			if (o !== v) diff.push(`row ${i}: oracle=${JSON.stringify(o)} stream=${JSON.stringify(v)}`);
		}
		console.error(`diff:\n${diff.join("\n")}`);
	}

	expect(streamed.viewport).toEqual(oracle.viewport);

	// No dropped glyphs relative to oracle, and no ghost duplicates past the logical count.
	const logicalCounts: Record<string, number> = {};
	for (const g of GLYPHS) logicalCounts[g] = s.finalLines.filter(l => l === g).length;

	for (const g of GLYPHS) {
		const sCount = countOccurrences(streamed.viewport, g);
		const oCount = countOccurrences(oracle.viewport, g);
		if (sCount !== oCount) {
			console.error(
				`[streaming-brackets] label=${label} glyph=${JSON.stringify(g)} stream=${sCount} oracle=${oCount}`,
			);
		}
		expect(sCount).toBe(oCount);
		// Ghost-duplicate guard: the viewport never inflates a glyph beyond its logical count.
		expect(sCount).toBeLessThanOrEqual(logicalCounts[g] ?? 0);
	}
}

describe("streaming transcript brackets — property", () => {
	it("converges to fresh-render across 20 seeded cases", async () => {
		for (let seed = 1; seed <= 20; seed++) {
			const s = genScenario(seed);
			try {
				await assertConverges(s, seed);
			} catch (e) {
				console.error(`[streaming-brackets] FAILED seed=${seed}`);
				throw e;
			}
		}
	}, 120_000);

	it("covers overflow + off-viewport mutation (deterministic seed=42)", async () => {
		// Hand-crafted scenario that guarantees both:
		//   (a) overflow: N > rows, so some emitted lines scroll off the top;
		//   (b) mid-stream mutation of an OFF-VIEWPORT bracket (index 0),
		//       exercising the `firstChanged < previousContentViewportTop`
		//       clamp branch from commit 8ea43b673.
		const cols = 30;
		const rows = 6;
		const seed = 42;
		const rng = mulberry32(seed);
		const N = 20; // > rows → guaranteed overflow
		const glyphs: string[] = [];
		for (let i = 0; i < N; i++) glyphs.push(pickGlyph(rng));
		const steps: string[][] = [];
		for (let i = 1; i <= N; i++) steps.push(glyphs.slice(0, i));
		// Mutate an off-viewport (j=0) bracket after all N emitted — distinct glyph.
		const before = glyphs[0] ?? GLYPHS[0]!;
		let next = before;
		while (next === before) next = pickGlyph(rng);
		glyphs[0] = next;
		steps.push(glyphs.slice());

		const s: Scenario = { cols, rows, finalLines: [...glyphs], steps };
		await assertConverges(s, "seed=42/overflow+offviewport-mut");
	}, 60_000);
});
