import { describe, expect, it } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("--plugin-dir flag parsing logic", () => {
	it("parses single --plugin-dir", () => {
		const args = parseArgs(["--plugin-dir", "./my-plugin"]);
		expect(args.pluginDirs).toEqual(["./my-plugin"]);
	});

	it("parses multiple --plugin-dir flags", () => {
		const args = parseArgs(["--plugin-dir", "./a", "--plugin-dir", "./b"]);
		expect(args.pluginDirs).toEqual(["./a", "./b"]);
	});

	it("returns undefined when no --plugin-dir", () => {
		const args = parseArgs([]);
		expect(args.pluginDirs).toBeUndefined();
	});

	it("ignores --plugin-dir with no value", () => {
		const args = parseArgs(["--plugin-dir"]);
		expect(args.pluginDirs).toBeUndefined();
	});
});
