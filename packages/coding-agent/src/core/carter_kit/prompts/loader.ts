/**
 * Template loader with content-addressed integrity checking.
 *
 * Text that gets surfaced (prompts, messages, warnings) lives in text files,
 * not hardcoded in TypeScript. Hashes live in hashes.toml — update that file
 * (not TS source) when template content changes.
 *
 * Hash scheme: sha3-256-trunc12 — SHA3-256 of UTF-8 content, first 12 hex chars.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { isBunBinary } from "../../../config.js";
import { EMBEDDED_HASH_REGISTRY, EMBEDDED_PROMPT_TEMPLATES } from "./embedded.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get optional prompts directory override.
 * - Bun binary: defaults to embedded templates (no filesystem dependency)
 * - Bun binary + PI_PROMPTS_DIR/PUNKIN_PROMPTS_DIR: use that directory
 * - Node.js: use __dirname (dist/core/carter_kit/prompts/ or src/core/carter_kit/prompts/)
 */
function getPromptsDir(): string | undefined {
	const envDir = process.env.PUNKIN_PROMPTS_DIR || process.env.PI_PROMPTS_DIR;
	if (envDir) {
		return envDir;
	}
	if (isBunBinary) {
		return undefined;
	}
	return __dirname;
}

const PROMPTS_DIR = getPromptsDir();
const EMBEDDED_HASHES: Record<string, string> = EMBEDDED_HASH_REGISTRY.templates as Record<string, string>;
const EMBEDDED_TEMPLATES: Record<string, string> = EMBEDDED_PROMPT_TEMPLATES as Record<string, string>;

// ============================================================================
// Hash registry — loaded once from hashes.toml at module init
// ============================================================================

interface HashRegistry {
	scheme: string;
	templates: Record<string, string>;
}

function loadHashRegistry(): HashRegistry {
	if (!PROMPTS_DIR) {
		return EMBEDDED_HASH_REGISTRY as HashRegistry;
	}
	const tomlPath = join(PROMPTS_DIR, "hashes.toml");
	if (!existsSync(tomlPath)) {
		return EMBEDDED_HASH_REGISTRY as HashRegistry;
	}
	const raw = readFileSync(tomlPath, "utf-8");
	return parseToml(raw) as unknown as HashRegistry;
}

const HASH_REGISTRY: HashRegistry = loadHashRegistry();

// ============================================================================
// Hashing
// ============================================================================

/**
 * Hash content with SHA3-256, return first 12 hex chars.
 * Matches scheme = "sha3-256-trunc12" in hashes.toml.
 */
export function hashContent(content: string): string {
	return createHash("sha3-256").update(content).digest("hex").slice(0, 12);
}

// ============================================================================
// Loaders
// ============================================================================

/**
 * Load a template file and verify its hash against hashes.toml.
 *
 * @param filename - File in prompts/ directory (must be in hashes.toml)
 * @returns The template content
 * @throws If hash doesn't match (content changed — update hashes.toml after review)
 * @throws If filename not found in registry
 */
export function loadTemplate(filename: string): string {
	const expectedHash = HASH_REGISTRY.templates[filename] ?? EMBEDDED_HASHES[filename];
	if (!expectedHash) {
		throw new Error(
			`Template "${filename}" not found in hashes.toml.\n` +
				`Add it: node -e "const {createHash}=require('crypto'),fs=require('fs'); ` +
				`console.log(createHash('sha3-256').update(fs.readFileSync('${filename}','utf-8')).digest('hex').slice(0,12));"`,
		);
	}

	const filepath = PROMPTS_DIR ? join(PROMPTS_DIR, filename) : undefined;
	const content = filepath && existsSync(filepath) ? readFileSync(filepath, "utf-8") : EMBEDDED_TEMPLATES[filename];
	if (content === undefined) {
		throw new Error(`Template "${filename}" missing from both filesystem and embedded bundle.`);
	}

	const actualHash = hashContent(content);

	if (actualHash !== expectedHash) {
		const tomlPath = PROMPTS_DIR ? join(PROMPTS_DIR, "hashes.toml") : "(embedded)";
		throw new Error(
			`Template hash mismatch for ${filename}:\n` +
				`  Expected : ${expectedHash}\n` +
				`  Actual   : ${actualHash}\n` +
				`\n` +
				`The file changed. Review the diff, then update hashes.toml:\n` +
				`  ${tomlPath}\n` +
				`\n` +
				`Replace the line:\n` +
				`  "${filename}" = "${expectedHash}"\n` +
				`with:\n` +
				`  "${filename}" = "${actualHash}"\n`,
		);
	}

	return content;
}

/**
 * Load template without hash check (for development/initial setup).
 * Prints the hash so you can add it to hashes.toml.
 */
export function loadTemplateUnchecked(filename: string): { content: string; hash: string } {
	const filepath = PROMPTS_DIR ? join(PROMPTS_DIR, filename) : undefined;
	const content = filepath && existsSync(filepath) ? readFileSync(filepath, "utf-8") : EMBEDDED_TEMPLATES[filename];
	if (content === undefined) {
		throw new Error(`Template "${filename}" missing from both filesystem and embedded bundle.`);
	}
	const hash = hashContent(content);
	console.log(`Template ${filename} hash: ${hash}`);
	return { content, hash };
}
