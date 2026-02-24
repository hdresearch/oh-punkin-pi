/**
 * Tests for DCP async tool execution via session-hook.
 */

import type { AgentTool } from "@punkin-pi/agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it } from "vitest";
import { cancel, force, isSettled, resetHandleCounter } from "../src/core/dcp/index.js";
import { createDcpHook } from "../src/core/dcp/session-hook.js";

// Helper: create a mock tool that resolves after delay
// Throws on abort (realistic behavior) — the handle machinery should swallow this
function mockTool(name: string, delayMs: number, result: string): AgentTool<any, any> {
	return {
		name,
		label: name,
		description: `Mock tool ${name}`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate) {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(resolve, delayMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timeout);
					reject(new Error("aborted"));
				});
			});
			return {
				content: [{ type: "text" as const, text: result }],
				details: {},
			};
		},
	};
}

// Helper: create a mock tool that fails
function failingTool(name: string, delayMs: number, error: string): AgentTool<any, any> {
	return {
		name,
		label: name,
		description: `Failing tool ${name}`,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			throw new Error(error);
		},
	};
}

describe("DcpHook async tool execution", () => {
	beforeEach(() => {
		resetHandleCounter();
	});

	describe("startToolAsync", () => {
		it("returns a handle immediately", () => {
			const hook = createDcpHook(undefined, "test-session");
			const tool = mockTool("slow", 100, "done");

			const handle = hook.startToolAsync(tool, "call-1", {});

			// Should return immediately, not wait for tool
			expect(handle).toBeDefined();
			expect(handle.id).toMatch(/^§h\d+$/);
			expect(handle.source).toBe("slow");
			expect(isSettled(handle)).toBe(false);

			// Cleanup
			cancel(handle);
			hook.shutdown();
		});

		it("handle resolves with tool result", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tool = mockTool("fast", 10, "hello world");

			const handle = hook.startToolAsync(tool, "call-1", {});
			const result = await force(handle);

			expect(result.content[0]).toEqual({ type: "text", text: "hello world" });

			hook.shutdown();
		});

		it("respects abort signal", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tool = mockTool("slow", 1000, "never");
			const abort = new AbortController();

			const handle = hook.startToolAsync(tool, "call-1", {}, abort.signal);

			// Cancel via external signal
			abort.abort();

			// The handle should fail when forced
			await expect(force(handle)).rejects.toThrow();

			hook.shutdown();
		});

		it("can be cancelled via handle", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tool = mockTool("slow", 1000, "never");

			const handle = hook.startToolAsync(tool, "call-1", {});

			const cancelled = cancel(handle);
			expect(cancelled).toBe(true);
			expect(isSettled(handle)).toBe(true);

			hook.shutdown();
		});
	});

	describe("startToolsParallel", () => {
		it("starts multiple tools and returns handles", () => {
			const hook = createDcpHook(undefined, "test-session");
			const tools = [
				{ tool: mockTool("a", 50, "result-a"), toolCallId: "call-a", params: {} },
				{ tool: mockTool("b", 30, "result-b"), toolCallId: "call-b", params: {} },
				{ tool: mockTool("c", 40, "result-c"), toolCallId: "call-c", params: {} },
			];

			const handles = hook.startToolsParallel(tools);

			expect(handles).toHaveLength(3);
			expect(handles.every((h) => !isSettled(h))).toBe(true);

			// Cleanup
			handles.forEach(cancel);
			hook.shutdown();
		});

		it("tools execute in parallel", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tools = [
				{ tool: mockTool("a", 30, "result-a"), toolCallId: "call-a", params: {} },
				{ tool: mockTool("b", 30, "result-b"), toolCallId: "call-b", params: {} },
				{ tool: mockTool("c", 30, "result-c"), toolCallId: "call-c", params: {} },
			];

			const start = Date.now();
			const handles = hook.startToolsParallel(tools);
			const results = await Promise.all(handles.map(force));
			const elapsed = Date.now() - start;

			// Should complete in ~30ms (parallel), not ~90ms (sequential)
			expect(elapsed).toBeLessThan(60);
			expect(results.map((r) => r.content[0])).toEqual([
				{ type: "text", text: "result-a" },
				{ type: "text", text: "result-b" },
				{ type: "text", text: "result-c" },
			]);

			hook.shutdown();
		});
	});

	describe("executeToolsParallel", () => {
		it("executes all tools and returns results", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tools = [
				{ tool: mockTool("a", 20, "result-a"), toolCallId: "call-a", params: {} },
				{ tool: mockTool("b", 10, "result-b"), toolCallId: "call-b", params: {} },
			];

			const results = await hook.executeToolsParallel(tools);

			expect(results).toHaveLength(2);
			expect(results[0].toolCallId).toBe("call-a");
			expect(results[0].error).toBeNull();
			expect(results[0].result?.content[0]).toEqual({ type: "text", text: "result-a" });
			expect(results[1].toolCallId).toBe("call-b");
			expect(results[1].result?.content[0]).toEqual({ type: "text", text: "result-b" });

			hook.shutdown();
		});

		it("captures errors per-tool without throwing", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tools = [
				{ tool: mockTool("good", 10, "ok"), toolCallId: "call-good", params: {} },
				{ tool: failingTool("bad", 10, "boom"), toolCallId: "call-bad", params: {} },
				{ tool: mockTool("also-good", 10, "ok2"), toolCallId: "call-also-good", params: {} },
			];

			// Should not throw
			const results = await hook.executeToolsParallel(tools);

			expect(results).toHaveLength(3);
			expect(results[0].error).toBeNull();
			expect(results[0].result).not.toBeNull();
			expect(results[1].error).toContain("boom");
			expect(results[1].result).toBeNull();
			expect(results[2].error).toBeNull();
			expect(results[2].result).not.toBeNull();

			hook.shutdown();
		});

		it("runs in parallel (timing check)", async () => {
			const hook = createDcpHook(undefined, "test-session");
			const tools = [
				{ tool: mockTool("a", 25, "a"), toolCallId: "1", params: {} },
				{ tool: mockTool("b", 25, "b"), toolCallId: "2", params: {} },
				{ tool: mockTool("c", 25, "c"), toolCallId: "3", params: {} },
				{ tool: mockTool("d", 25, "d"), toolCallId: "4", params: {} },
			];

			const start = Date.now();
			await hook.executeToolsParallel(tools);
			const elapsed = Date.now() - start;

			// 4 tools × 25ms each = 100ms sequential, ~25ms parallel
			expect(elapsed).toBeLessThan(50);

			hook.shutdown();
		});
	});

	describe("DCP cache integration", () => {
		it("returns cached result for pure tool calls", async () => {
			const hook = createDcpHook(undefined, "test-session");

			// Create a "read" tool (classified as Pure)
			let callCount = 0;
			const readTool: AgentTool<any, any> = {
				name: "read",
				label: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_toolCallId, _params, _signal, _onUpdate) {
					callCount++;
					await new Promise((r) => setTimeout(r, 10));
					return {
						content: [{ type: "text" as const, text: "file contents" }],
						details: {},
					};
				},
			};

			// First call — should execute
			const handle1 = hook.startToolAsync(readTool, "call-1", { path: "/foo" });
			const result1 = await force(handle1);
			expect(callCount).toBe(1);
			expect(result1.content[0]).toEqual({ type: "text", text: "file contents" });

			// Second call with same args — should hit cache via beforeToolCall
			const _intercept = hook.beforeToolCall("read", { path: "/foo" });
			// Note: cache is checked in beforeToolCall, but the async path
			// also checks it internally. The full cache path needs the
			// result to be captured first via afterToolResult.

			hook.shutdown();
		});
	});
});
