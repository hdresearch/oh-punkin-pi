import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@ohp/ai";
import type { Args } from "../src/cli/args";
import { buildInitialMessage } from "../src/cli/initial-message";

function createArgs(messages: string[]): Args {
	return {
		messages,
		fileArgs: [],
		unknownFlags: new Map(),
	};
}

describe("buildInitialMessage", () => {
	it("combines stdin, file text, and the first CLI message", () => {
		const parsed = createArgs(["first", "second"]);
		const images: ImageContent[] = [{ type: "image", data: "abc123", mimeType: "image/png" }];

		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin",
			fileText: "file-",
			fileImages: images,
		});

		expect(result.initialMessage).toBe("stdin\nfile-first");
		expect(result.initialImages).toEqual(images);
		expect(parsed.messages).toEqual(["second"]);
	});

	it("consumes first CLI message as initialMessage when no file or stdin input", () => {
		const parsed = createArgs(["first", "second"]);

		const result = buildInitialMessage({ parsed });

		expect(result.initialMessage).toBe("first");
		expect(result.initialImages).toBeUndefined();
		expect(parsed.messages).toEqual(["second"]);
	});

	it("returns undefined when no messages, files, or stdin", () => {
		const parsed = createArgs([]);

		const result = buildInitialMessage({ parsed });

		expect(result.initialMessage).toBeUndefined();
		expect(result.initialImages).toBeUndefined();
	});
});
