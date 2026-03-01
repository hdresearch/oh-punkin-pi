import type { AgentMessage } from "@punkin-pi/agent-core";
import type { AssistantMessage, Timestamp, UserMessage } from "@punkin-pi/ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.js";

// ============================================================================
// Helpers
// ============================================================================

function ts(offset: number): Timestamp {
	const d = new Date("2026-02-24T12:00:00-05:00");
	d.setSeconds(d.getSeconds() + offset);
	return d.toISOString() as Timestamp;
}

function userMsg(text: string, offset: number): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: ts(offset),
		endTimestamp: ts(offset + 1),
	};
}

function assistantMsg(text: string, offset: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "messages",
		model: "test",
		provider: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: ts(offset),
		endTimestamp: ts(offset + 2),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("convertToLlm", () => {
	describe("role boundary wrapping", () => {
		it("wraps user messages with boundary markers", () => {
			const messages: AgentMessage[] = [userMsg("hello world", 0)];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");

			const content = result[0].content as string;
			// Should have [user]{ prefix
			expect(content).toMatch(/^\[user\]\{/);
			// Should contain the original text
			expect(content).toContain("hello world");
			// Should have turn number
			expect(content).toMatch(/turn:1/);
			// Should have timestamp (format: T=YYYY-MM-DDTHH:MM:SS)
			expect(content).toMatch(/T=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
			// Should have hash
			expect(content).toMatch(/H=[a-f0-9]{12}/);
			// Should have closing sigil
			expect(content).toMatch(/\}$/);
		});

		it("wraps assistant messages with boundary markers", () => {
			const messages: AgentMessage[] = [userMsg("hello", 0), assistantMsg("hi there", 5)];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(2);
			expect(result[1].role).toBe("assistant");

			const content = (result[1] as AssistantMessage).content;
			expect(content).toHaveLength(1);
			expect(content[0].type).toBe("text");

			const text = (content[0] as { type: "text"; text: string }).text;
			// Should have [assistant]{ prefix
			expect(text).toMatch(/^\[assistant\]\{/);
			// Should contain the original text
			expect(text).toContain("hi there");
			// Assistant doesn't increment turn, so still turn 1
			expect(text).toMatch(/turn:1/);
		});

		it("increments turn only for user-like messages", () => {
			const messages: AgentMessage[] = [
				userMsg("first", 0),
				assistantMsg("response 1", 5),
				userMsg("second", 10),
				assistantMsg("response 2", 15),
				userMsg("third", 20),
			];
			const result = convertToLlm(messages);

			// Extract turn numbers from wrapped content
			const getTurn = (m: (typeof result)[number]): number | null => {
				const content =
					m.role === "assistant"
						? ((m as AssistantMessage).content[0] as { type: "text"; text: string }).text
						: (m.content as string);
				const match = content.match(/turn:(\d+)/);
				return match ? parseInt(match[1], 10) : null;
			};

			expect(getTurn(result[0])).toBe(1); // user: first
			expect(getTurn(result[1])).toBe(1); // assistant after first user
			expect(getTurn(result[2])).toBe(2); // user: second
			expect(getTurn(result[3])).toBe(2); // assistant after second user
			expect(getTurn(result[4])).toBe(3); // user: third
		});

		it("computes delta between messages", () => {
			const messages: AgentMessage[] = [
				userMsg("first", 0),
				userMsg("second", 120), // 2 minutes later
			];
			const result = convertToLlm(messages);

			const content1 = result[0].content as string;
			const content2 = result[1].content as string;

			// First message has no delta
			expect(content1).not.toMatch(/Δ/);
			// Second message should have delta (approximately 2m)
			expect(content2).toMatch(/Δ2m/);
		});
	});

	describe("message type handling", () => {
		it("preserves images in user messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc123" } },
					],
					timestamp: ts(0),
					endTimestamp: ts(1),
				},
			];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(1);
			const content = (result[0] as UserMessage).content;
			expect(Array.isArray(content)).toBe(true);
			expect((content as any[]).length).toBe(2);
			// First should be wrapped text
			expect((content as any[])[0].type).toBe("text");
			expect((content as any[])[0].text).toMatch(/^\[user\]\{/);
			// Second should be preserved image
			expect((content as any[])[1].type).toBe("image");
		});

		it("does not wrap toolResult messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "toolResult",
					toolCallId: "call_123",
					content: [{ type: "text", text: "tool output" }],
					isError: false,
					timestamp: ts(0),
					endTimestamp: ts(1),
				},
			];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("toolResult");
			// Content should be unchanged
			const content = (result[0] as any).content;
			expect(content[0].text).toBe("tool output");
			expect(content[0].text).not.toMatch(/^\[/);
		});

		it("preserves toolCalls in assistant messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me help" },
						{ type: "toolCall", toolCallId: "call_1", toolName: "read", args: { path: "/foo" } },
					],
					api: "messages",
					model: "test",
					provider: "test",
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: ts(0),
					endTimestamp: ts(2),
				},
			];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(1);
			const content = (result[0] as AssistantMessage).content;
			expect(content).toHaveLength(2);
			// First should be wrapped text
			expect(content[0].type).toBe("text");
			expect((content[0] as any).text).toMatch(/^\[assistant\]\{/);
			// Second should be preserved toolCall
			expect(content[1].type).toBe("toolCall");
			expect((content[1] as any).toolName).toBe("read");
		});

		it("handles bashExecution messages", () => {
			const messages: AgentMessage[] = [
				{
					role: "bashExecution",
					command: "ls -la",
					output: "file1.txt\nfile2.txt",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: ts(0),
					endTimestamp: ts(1),
				},
			];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");
			const text = (result[0].content as { type: "text"; text: string }[])[0].text;
			expect(text).toMatch(/^\[user\]\{/);
			expect(text).toContain("ls -la");
			expect(text).toContain("file1.txt");
		});

		it("skips bashExecution with excludeFromContext", () => {
			const messages: AgentMessage[] = [
				{
					role: "bashExecution",
					command: "secret-command",
					output: "secret output",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: ts(0),
					endTimestamp: ts(1),
				},
			];
			const result = convertToLlm(messages);

			expect(result).toHaveLength(0);
		});
	});

	describe("content hashing", () => {
		it("produces consistent hashes for same content", () => {
			const msg1 = userMsg("test content", 0);
			const msg2 = userMsg("test content", 0);

			const result1 = convertToLlm([msg1]);
			const result2 = convertToLlm([msg2]);

			const hash1 = (result1[0].content as string).match(/H=([a-f0-9]{12})/)?.[1];
			const hash2 = (result2[0].content as string).match(/H=([a-f0-9]{12})/)?.[1];

			expect(hash1).toBe(hash2);
		});

		it("produces different hashes for different content", () => {
			const msg1 = userMsg("content A", 0);
			const msg2 = userMsg("content B", 0);

			const result1 = convertToLlm([msg1]);
			const result2 = convertToLlm([msg2]);

			const hash1 = (result1[0].content as string).match(/H=([a-f0-9]{12})/)?.[1];
			const hash2 = (result2[0].content as string).match(/H=([a-f0-9]{12})/)?.[1];

			expect(hash1).not.toBe(hash2);
		});
	});
});
