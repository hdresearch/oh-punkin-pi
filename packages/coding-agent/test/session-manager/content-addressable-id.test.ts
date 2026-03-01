import type { Timestamp } from "@punkin-pi/ai";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

function userMsg(text: string) {
	const ts = new Date().toISOString() as Timestamp;
	return {
		role: "user" as const,
		content: text,
		timestamp: ts,
		endTimestamp: ts,
	};
}

function assistantMsg(text: string) {
	const ts = new Date().toISOString() as Timestamp;
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "messages" as const,
		model: "test",
		provider: "test",
		stopReason: "stop" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: ts,
		endTimestamp: ts,
	};
}

describe("content-addressable IDs", () => {
	it("generates 12 hex char IDs", () => {
		const session = SessionManager.inMemory();
		const id = session.appendMessage(userMsg("hello"));

		expect(id).toMatch(/^[a-f0-9]{12}$/);
	});

	it("different content produces different IDs", () => {
		const session = SessionManager.inMemory();
		const id1 = session.appendMessage(userMsg("hello"));
		const id2 = session.appendMessage(userMsg("world"));

		expect(id1).not.toBe(id2);
	});

	it("entry ID depends on parentId (Merkle list property)", () => {
		// Create two sessions with same messages but different history
		const session1 = SessionManager.inMemory();
		const session2 = SessionManager.inMemory();

		// Session 1: A -> B -> C
		session1.appendMessage(userMsg("A"));
		session1.appendMessage(assistantMsg("B"));
		const id1_C = session1.appendMessage(userMsg("C"));

		// Session 2: X -> Y -> C (same "C" content, different prefix)
		session2.appendMessage(userMsg("X"));
		session2.appendMessage(assistantMsg("Y"));
		const id2_C = session2.appendMessage(userMsg("C"));

		// Same content "C" but different parentId => different ID
		expect(id1_C).not.toBe(id2_C);
	});

	it("parentId chain forms Merkle list", () => {
		const session = SessionManager.inMemory();

		const id1 = session.appendMessage(userMsg("first"));
		const id2 = session.appendMessage(assistantMsg("second"));
		const id3 = session.appendMessage(userMsg("third"));

		const entries = session.getEntries();
		const e1 = entries.find((e) => e.id === id1)!;
		const e2 = entries.find((e) => e.id === id2)!;
		const e3 = entries.find((e) => e.id === id3)!;

		// Chain: null <- e1 <- e2 <- e3
		expect(e1.parentId).toBeNull();
		expect(e2.parentId).toBe(id1);
		expect(e3.parentId).toBe(id2);

		// Each ID is hash of content + parentId + ts
		// Since parentId is itself content-addressable,
		// changing any ancestor changes all descendant IDs
	});

	it("precise timestamp prevents collision for rapid appends", () => {
		const session = SessionManager.inMemory();
		const ids = new Set<string>();

		// Rapidly append many messages with same content
		for (let i = 0; i < 100; i++) {
			const id = session.appendMessage(userMsg("same"));
			ids.add(id);
		}

		// All should be unique despite same content
		expect(ids.size).toBe(100);
	});

	it("entry has both ts (precise) and timestamp (ISO)", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("test"));

		const entry = session.getEntries()[0];

		// ts is epoch micros (numeric string)
		expect(entry.ts).toMatch(/^\d+$/);
		expect(Number(entry.ts)).toBeGreaterThan(1700000000000000); // After 2023 in micros

		// timestamp is ISO string
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("branches produce different IDs for same content", () => {
		const session = SessionManager.inMemory();

		// Main: A -> B
		const idA = session.appendMessage(userMsg("A"));
		session.appendMessage(assistantMsg("B"));

		// Branch from A: A -> C (same position, different content after)
		session.branch(idA);
		const idC_branch = session.appendMessage(userMsg("C"));

		// Back to main, continue: A -> B -> C
		session.branch(idA);
		session.appendMessage(assistantMsg("B-again")); // different parent now
		const idC_main = session.appendMessage(userMsg("C"));

		// Same "C" content at different tree positions => different IDs
		expect(idC_branch).not.toBe(idC_main);
	});
});
