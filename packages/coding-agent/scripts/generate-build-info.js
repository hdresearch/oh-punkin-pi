#!/usr/bin/env node
/**
 * Generate build-info.ts with git commit hash, timestamp, and package config.
 * Called during build to embed provenance and config in the binary.
 * 
 * This eliminates runtime dependency on package.json for compiled binaries.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "src", "build-info.ts");
const pkgPath = join(__dirname, "..", "package.json");

function getGitCommit() {
	try {
		return execSync("git rev-parse --short=12 HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}

function getNycTimestamp() {
	const now = new Date();
	const nyc = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(now);

	const parts = {};
	for (const p of nyc) parts[p.type] = p.value;
	return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}NYC`;
}

// Read package.json for version and config
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const version = pkg.version || "0.0.0";
// Support both punkinConfig and piConfig for backwards compat
const config = pkg.punkinConfig || pkg.piConfig || {};
const appName = config.name || "punkin";
const configDirName = config.configDir || ".punkin";

const commit = getGitCommit();
const timestamp = getNycTimestamp();

const content = `/**
 * Build info - generated at build time by scripts/generate-build-info.js
 * DO NOT EDIT MANUALLY
 */

export const BUILD_COMMIT: string = "${commit}";
export const BUILD_TIME: string = "${timestamp}";

// Package config - embedded at build time to avoid runtime package.json dependency
export const VERSION: string = "${version}";
export const APP_NAME: string = "${appName}";
export const CONFIG_DIR_NAME: string = "${configDirName}";
`;

writeFileSync(outPath, content);
console.log(`build-info.ts: ${commit} ${timestamp} v${version} ${appName}/${configDirName}`);
