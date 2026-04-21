import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@ohp/coding-agent/capability/context-file";
import { clearCache } from "@ohp/coding-agent/capability/fs";
import { _resetSettingsForTest, Settings } from "@ohp/coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@ohp/coding-agent/discovery";

describe("user agent authority suppresses project AGENTS.md sources", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearCache();
		_resetSettingsForTest();
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-authority-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-authority-project-"));
		await fs.mkdir(path.join(tempHomeDir, ".agent"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".agent"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".ohp"), { recursive: true });

		await Bun.write(path.join(tempHomeDir, ".agent", "AGENT.md"), "# User authority\n");
		await Bun.write(path.join(tempDir, "AGENTS.md"), "# Bare project AGENTS\n");
		await Bun.write(path.join(tempDir, ".agent", "AGENTS.md"), "# Project .agent AGENTS\n");
		await Bun.write(path.join(tempDir, ".ohp", "AGENTS.md"), "# Project .ohp AGENTS\n");

		const settings = await Settings.init({ inMemory: true, cwd: tempDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		clearCache();
		_resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(tempHomeDir, { recursive: true, force: true });
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("runtime context loading excludes project AGENTS.md files", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		const projectAgents = result.items.filter(
			item => item.level === "project" && path.basename(item.path) === "AGENTS.md",
		);
		expect(projectAgents).toHaveLength(0);

		const userAgent = result.items.find(item => item.level === "user" && path.basename(item.path) === "AGENT.md");
		expect(userAgent?.path).toBe(path.join(tempHomeDir, ".agent", "AGENT.md"));
	});
});
