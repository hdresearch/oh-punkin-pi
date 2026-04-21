/**
 * Property-testing harness for TUI rendering.
 *
 * Self-contained — no external dependencies. Uses xterm.js headless (already
 * a TUI devDep) for terminal emulation and a seeded mulberry32 PRNG for
 * reproducibility.
 *
 * Exposes:
 *   - mulberry32(seed): () => [0,1)
 *   - MarkerFocusableComponent: mutable lines + cursor col + CURSOR_MARKER emission
 *   - snapshotTerminal(term): { viewport, cursor: {x, y, visible} }
 *   - freshRender(lines, ...): what the screen SHOULD look like after a
 *     from-scratch render of the same logical lines (reference oracle).
 */

import type { Focusable } from "@ohp/tui";
import { type Component, CURSOR_MARKER, TUI } from "@ohp/tui";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { VirtualTerminal } from "../virtual-terminal";

// ── deterministic PRNG ──────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pickInt(rng: () => number, lo: number, hi: number): number {
	return lo + Math.floor(rng() * (hi - lo + 1));
}

// ── focusable component with CURSOR_MARKER ─────────────────────────────────

export class MarkerFocusableComponent implements Component, Focusable {
	focused = false;
	#lines: string[];
	#cursorRow: number;
	#cursorCol: number;

	constructor(lines: string[], cursorRow = 0, cursorCol = 0) {
		this.#lines = [...lines];
		this.#cursorRow = cursorRow;
		this.#cursorCol = cursorCol;
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
		if (this.#cursorRow >= this.#lines.length) {
			this.#cursorRow = Math.max(0, this.#lines.length - 1);
		}
		const curLine = this.#lines[this.#cursorRow] ?? "";
		if (this.#cursorCol > curLine.length) this.#cursorCol = curLine.length;
	}

	setCursor(row: number, col: number): void {
		this.#cursorRow = Math.max(0, Math.min(row, Math.max(0, this.#lines.length - 1)));
		const curLine = this.#lines[this.#cursorRow] ?? "";
		this.#cursorCol = Math.max(0, Math.min(col, curLine.length));
	}

	getLines(): string[] {
		return [...this.#lines];
	}

	getCursor(): { row: number; col: number } {
		return { row: this.#cursorRow, col: this.#cursorCol };
	}

	invalidate(): void {}

	render(_width: number): string[] {
		if (!this.focused) return [...this.#lines];
		const rendered = [...this.#lines];
		if (rendered.length === 0) rendered.push("");
		const row = Math.min(this.#cursorRow, rendered.length - 1);
		const line = rendered[row];
		const col = Math.min(this.#cursorCol, line.length);
		rendered[row] = line.slice(0, col) + CURSOR_MARKER + line.slice(col);
		return rendered;
	}
}

// ── xterm state snapshot ───────────────────────────────────────────────────

export interface CursorSnapshot {
	/** 0-indexed column on the visible viewport */
	x: number;
	/** 0-indexed row on the visible viewport */
	y: number;
	/** xterm `cursorHidden` state (true = hidden, i.e. ?25l) */
	hidden: boolean;
}

export interface TerminalSnapshot {
	viewport: string[];
	cursor: CursorSnapshot;
}

export function snapshotTerminal(term: VirtualTerminal): TerminalSnapshot {
	const xterm = (term as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	// xterm exposes cursorY relative to buffer start; subtract viewportY for screen row.
	const y = buffer.cursorY; // already viewport-relative on active buffer
	const x = buffer.cursorX;
	// cursor visibility via private state on Core terminal.
	// Cast to access internal `_core` (xterm headless doesn't expose `getOption("cursorHidden")` publicly).
	// Fall back to `false` (shown) if unavailable — snapshot docs this best-effort semantic.
	type XtermCore = { _core?: { _coreService?: { isCursorHidden?: boolean }; cursorHidden?: boolean } };
	const coreAny = xterm as unknown as XtermCore;
	const hidden = coreAny._core?._coreService?.isCursorHidden ?? coreAny._core?.cursorHidden ?? false;
	const viewport = term.getViewport().map(l => l.trimEnd());
	return { viewport, cursor: { x, y, hidden } };
}

// ── fresh-render oracle ─────────────────────────────────────────────────────

/**
 * Produce a TerminalSnapshot by rendering `lines` into a freshly-started TUI.
 * Serves as ground-truth reference: whatever the stepwise harness produces
 * MUST converge to this when given the same final component state.
 *
 * The `mount` callback receives a fresh harness so the caller can place
 * components and register overlays matching the scenario under test.
 */
export async function freshRender(
	cols: number,
	rows: number,
	mount: (harness: Harness) => void | Promise<void>,
): Promise<TerminalSnapshot> {
	const h = new Harness(cols, rows);
	await mount(h);
	h.start();
	await h.settle();
	const snap = snapshotTerminal(h.term);
	h.stop();
	return snap;
}

// ── convenience harness ─────────────────────────────────────────────────────

export async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(0);
	await term.flush();
}

export class Harness {
	readonly term: VirtualTerminal;
	readonly tui: TUI;

	constructor(cols: number, rows: number, showHardwareCursor = true) {
		this.term = new VirtualTerminal(cols, rows);
		this.tui = new TUI(this.term, showHardwareCursor);
	}

	start(): void {
		this.tui.start();
	}

	stop(): void {
		this.tui.stop();
	}

	async settle(): Promise<void> {
		await settle(this.term);
	}

	snapshot(): TerminalSnapshot {
		return snapshotTerminal(this.term);
	}
}
