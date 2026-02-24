/**
 * Tests for DCP RuntimeHandle — async handle lifecycle primitives.
 *
 * These are the CBN (call-by-need) thunks for tool results.
 */

import { describe, expect, it } from "vitest";
import type { RuntimeHandle, RuntimeHandleStatus } from "../src/core/dcp/index.js";
import {
	awaitSettled,
	cancel,
	cancelAll,
	force,
	forceAll,
	forceAllSettled,
	freshHandleId,
	Inflight,
	isPending,
	isSettled,
	mkRuntimeHandle,
	poll,
	RCancelled,
	RFailed,
	RResolved,
	raceHandles,
	resetHandleCounter,
	tryForce,
} from "../src/core/dcp/index.js";

// Helper: create a handle that resolves after delay
// Uses a "silent abort" pattern — cancellation just resolves to a sentinel,
// avoiding unhandled rejection noise in tests
function delayedHandle<A>(value: A, delayMs: number): RuntimeHandle<A> {
	const abort = new AbortController();
	const promise = new Promise<A>((resolve) => {
		const timeout = setTimeout(() => resolve(value), delayMs);
		abort.signal.addEventListener("abort", () => {
			clearTimeout(timeout);
			// Don't reject — the cancel() function already sets RCancelled status
			// Just resolve with the value (it won't be used since status is already terminal)
			resolve(value);
		});
	});
	return mkRuntimeHandle(freshHandleId(), "test", promise, abort);
}

// Helper: create a handle that fails after delay
function failingHandle(error: string, delayMs: number): RuntimeHandle<never> {
	const abort = new AbortController();
	const promise = new Promise<never>((_, reject) => {
		const timeout = setTimeout(() => reject(new Error(error)), delayMs);
		abort.signal.addEventListener("abort", () => {
			clearTimeout(timeout);
			// Same pattern — don't reject on abort, status already set
		});
	});
	return mkRuntimeHandle(freshHandleId(), "test", promise, abort);
}

// Helper: create an immediately resolved handle
function resolvedHandle<A>(value: A): RuntimeHandle<A> {
	const abort = new AbortController();
	const promise = Promise.resolve(value);
	const handle = mkRuntimeHandle(freshHandleId(), "test", promise, abort);
	// Manually set to resolved state — cast needed because status is typed for promise result
	(handle as { status: RuntimeHandleStatus<A> }).status = RResolved(value);
	return handle;
}

describe("RuntimeHandle creation", () => {
	it("mkRuntimeHandle creates Inflight state", () => {
		resetHandleCounter();
		const abort = new AbortController();
		const promise = Promise.resolve(42);
		const handle = mkRuntimeHandle(freshHandleId(), "bash", promise, abort);

		expect(handle.id).toBe("§h0");
		expect(handle.source).toBe("bash");
		expect(handle.status.tag).toBe("Inflight");
		expect(isPending(handle)).toBe(true);
		expect(isSettled(handle)).toBe(false);
	});

	it("freshHandleId increments", () => {
		resetHandleCounter();
		expect(freshHandleId()).toBe("§h0");
		expect(freshHandleId()).toBe("§h1");
		expect(freshHandleId()).toBe("§h2");
	});
});

describe("force", () => {
	it("waits for Inflight promise to resolve", async () => {
		const handle = delayedHandle(42, 10);
		expect(handle.status.tag).toBe("Inflight");

		const result = await force(handle);

		expect(result).toBe(42);
		expect(handle.status.tag).toBe("RResolved");
		if (handle.status.tag === "RResolved") {
			expect(handle.status.value).toBe(42);
		}
	});

	it("returns immediately for RResolved", async () => {
		const handle = resolvedHandle("already done");

		const start = Date.now();
		const result = await force(handle);
		const elapsed = Date.now() - start;

		expect(result).toBe("already done");
		expect(elapsed).toBeLessThan(5); // should be instant
	});

	it("throws for RCancelled", async () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RCancelled();

		await expect(force(handle)).rejects.toThrow("was cancelled");
	});

	it("throws for RFailed", async () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RFailed("something broke");

		await expect(force(handle)).rejects.toThrow("something broke");
	});

	it("updates status to RFailed when promise rejects", async () => {
		const handle = failingHandle("boom", 10);

		await expect(force(handle)).rejects.toThrow("boom");
		expect(handle.status.tag).toBe("RFailed");
		if (handle.status.tag === "RFailed") {
			expect(handle.status.error).toBe("boom");
		}
	});
});

describe("tryForce", () => {
	it("returns ok: true on success", async () => {
		const handle = delayedHandle(42, 10);
		const result = await tryForce(handle);

		expect(result).toEqual({ ok: true, value: 42 });
	});

	it("returns ok: false on failure", async () => {
		const handle = failingHandle("oops", 10);
		const result = await tryForce(handle);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("oops");
		}
	});

	it("returns ok: false for cancelled", async () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RCancelled();

		const result = await tryForce(handle);
		expect(result.ok).toBe(false);
	});
});

describe("cancel", () => {
	it("cancels Inflight handle", () => {
		const handle = delayedHandle(42, 1000);
		expect(handle.status.tag).toBe("Inflight");

		const cancelled = cancel(handle);

		expect(cancelled).toBe(true);
		expect(handle.status.tag).toBe("RCancelled");
	});

	it("returns false for already resolved", () => {
		const handle = resolvedHandle(42);

		const cancelled = cancel(handle);

		expect(cancelled).toBe(false);
		expect(handle.status.tag).toBe("RResolved");
	});

	it("returns false for already cancelled", () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RCancelled();

		const cancelled = cancel(handle);

		expect(cancelled).toBe(false);
	});

	it("signals abort to the AbortController", async () => {
		let abortSignaled = false;
		const abort = new AbortController();
		abort.signal.addEventListener("abort", () => {
			abortSignaled = true;
		});

		const promise = new Promise<number>((resolve) => setTimeout(() => resolve(42), 1000));
		const handle = mkRuntimeHandle(freshHandleId(), "test", promise, abort);

		cancel(handle);

		expect(abortSignaled).toBe(true);
	});
});

describe("poll", () => {
	it("returns current status without blocking", () => {
		const handle = delayedHandle(42, 1000);

		const status = poll(handle);

		expect(status.tag).toBe("Inflight");
	});

	it("reflects status changes", async () => {
		const handle = delayedHandle(42, 10);

		expect(poll(handle).tag).toBe("Inflight");
		await force(handle);
		expect(poll(handle).tag).toBe("RResolved");
	});
});

describe("isSettled / isPending", () => {
	it("Inflight is pending, not settled", () => {
		const handle = delayedHandle(42, 1000);
		expect(isPending(handle)).toBe(true);
		expect(isSettled(handle)).toBe(false);
	});

	it("RResolved is settled, not pending", () => {
		const handle = resolvedHandle(42);
		expect(isPending(handle)).toBe(false);
		expect(isSettled(handle)).toBe(true);
	});

	it("RCancelled is settled", () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RCancelled();
		expect(isSettled(handle)).toBe(true);
	});

	it("RFailed is settled", () => {
		const handle = delayedHandle(42, 1000);
		handle.status = RFailed("error");
		expect(isSettled(handle)).toBe(true);
	});
});

describe("forceAll", () => {
	it("resolves all handles in parallel", async () => {
		const handles = [delayedHandle(1, 20), delayedHandle(2, 10), delayedHandle(3, 15)];

		const start = Date.now();
		const results = await forceAll(handles);
		const elapsed = Date.now() - start;

		expect(results).toEqual([1, 2, 3]);
		// Should complete in ~20ms (max delay), not 45ms (sum of delays)
		expect(elapsed).toBeLessThan(40);
	});

	it("propagates first error", async () => {
		const handles = [delayedHandle(1, 20), failingHandle("boom", 10), delayedHandle(3, 15)];

		await expect(forceAll(handles)).rejects.toThrow("boom");
	});
});

describe("forceAllSettled", () => {
	it("collects all results including errors", async () => {
		const handles = [
			delayedHandle(1, 10),
			failingHandle("boom", 10),
			delayedHandle(3, 10),
		] as RuntimeHandle<number>[];

		const results = await forceAllSettled(handles);

		expect(results[0]).toEqual({ ok: true, value: 1 });
		expect(results[1].ok).toBe(false);
		if (!results[1].ok) expect(results[1].error).toContain("boom");
		expect(results[2]).toEqual({ ok: true, value: 3 });
	});

	it("never throws", async () => {
		const handles = [failingHandle("a", 10), failingHandle("b", 10)] as RuntimeHandle<number>[];

		// Should not throw
		const results = await forceAllSettled(handles);

		expect(results.every((r) => !r.ok)).toBe(true);
	});
});

describe("raceHandles", () => {
	it("returns first to resolve", async () => {
		resetHandleCounter();
		const slow = delayedHandle("slow", 100);
		const fast = delayedHandle("fast", 10);
		const medium = delayedHandle("medium", 50);

		const { winner, value } = await raceHandles([slow, fast, medium]);

		expect(value).toBe("fast");
		expect(winner).toBe(fast);
	});

	it("throws on empty list", async () => {
		await expect(raceHandles([])).rejects.toThrow("empty list");
	});
});

describe("cancelAll", () => {
	it("cancels all inflight handles", () => {
		const handles = [delayedHandle(1, 1000), delayedHandle(2, 1000), delayedHandle(3, 1000)];

		const count = cancelAll(handles);

		expect(count).toBe(3);
		expect(handles.every((h) => h.status.tag === "RCancelled")).toBe(true);
	});

	it("skips already settled handles", () => {
		const handles = [delayedHandle(1, 1000), resolvedHandle(2), delayedHandle(3, 1000)];

		const count = cancelAll(handles);

		expect(count).toBe(2);
		expect(handles[0].status.tag).toBe("RCancelled");
		expect(handles[1].status.tag).toBe("RResolved");
		expect(handles[2].status.tag).toBe("RCancelled");
	});
});

describe("awaitSettled", () => {
	it("waits for all handles to settle", async () => {
		const handles = [delayedHandle(1, 10), delayedHandle(2, 20), delayedHandle(3, 15)];

		await awaitSettled(handles);

		expect(handles.every(isSettled)).toBe(true);
	});

	it("handles already-settled handles", async () => {
		const handles = [resolvedHandle(1), resolvedHandle(2)];

		// Should complete immediately without error
		await awaitSettled(handles);

		expect(handles.every(isSettled)).toBe(true);
	});
});

describe("RuntimeHandleStatus constructors", () => {
	it("Inflight holds promise and abort", () => {
		const promise = Promise.resolve(42);
		const abort = new AbortController();
		const status = Inflight(promise, abort);

		expect(status.tag).toBe("Inflight");
		if (status.tag === "Inflight") {
			expect(status.promise).toBe(promise);
			expect(status.abort).toBe(abort);
		}
	});

	it("RResolved holds value and timestamp", () => {
		const status = RResolved(42, 1000);

		expect(status.tag).toBe("RResolved");
		if (status.tag === "RResolved") {
			expect(status.value).toBe(42);
			expect(status.resolvedAt).toBe(1000);
		}
	});

	it("RResolved uses Date.now() as default", () => {
		const before = Date.now();
		const status = RResolved(42);
		const after = Date.now();

		expect(status.tag).toBe("RResolved");
		if (status.tag === "RResolved") {
			expect(status.resolvedAt).toBeGreaterThanOrEqual(before);
			expect(status.resolvedAt).toBeLessThanOrEqual(after);
		}
	});

	it("RCancelled holds timestamp", () => {
		const status = RCancelled(1000);

		expect(status.tag).toBe("RCancelled");
		if (status.tag === "RCancelled") {
			expect(status.cancelledAt).toBe(1000);
		}
	});

	it("RFailed holds error and timestamp", () => {
		const status = RFailed("oops", 1000);

		expect(status.tag).toBe("RFailed");
		if (status.tag === "RFailed") {
			expect(status.error).toBe("oops");
			expect(status.failedAt).toBe(1000);
		}
	});
});
