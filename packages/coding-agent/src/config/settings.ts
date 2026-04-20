/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	isEnoent,
	logger,
	procmgr,
	setDefaultTabWidth,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-registry";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { type EditMode, normalizeEditMode } from "../patch";
import { AgentStorage } from "../session/agent-storage";
import { withFileLock } from "./file-lock";
import {
	type BashInterceptorRule,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Schema invariant lint (module-load assertion)
// ═══════════════════════════════════════════════════════════════════════════
// Every schema key MUST be namespaced (contain at least one '.'). Bare
// top-level keys break uniform 'group by prefix' emission and force the
// emitter to use a synthetic 'default.*' bucket. Prevent regressions.
{
	const _bare = Object.keys(SETTINGS_SCHEMA).filter(k => !k.includes("."));
	if (_bare.length > 0) {
		throw new Error(
			`SETTINGS_SCHEMA contains ${_bare.length} bare top-level key(s) — every key must be namespaced (e.g. 'foo.bar'). Offenders: ${_bare.join(", ")}`,
		);
	}
}

// Path P must not be a strict prefix of any other path Q (joined by '.'),
// or P would be both a leaf scalar AND an interior node — unrepresentable in TOML
// ("Cannot overwrite a value") and ill-formed conceptually.
{
	const _paths = Object.keys(SETTINGS_SCHEMA);
	const _conflicts: Array<[string, string]> = [];
	for (const p of _paths) {
		for (const q of _paths) {
			if (q.startsWith(`${p}.`)) _conflicts.push([p, q]);
		}
	}
	if (_conflicts.length > 0) {
		throw new Error(
			`SETTINGS_SCHEMA leaf-vs-branch conflicts: ${_conflicts.map(([p, q]) => `'${p}' is leaf AND '${q}' implies '${p}' is interior`).join("; ")}`,
		);
	}
}

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for config.yml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a dotted path into segments.
 * "compaction.enabled" → ["compaction", "enabled"]
 * "theme.dark" → ["theme", "dark"]
 */
function parsePath(path: string): string[] {
	return path.split(".");
}

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/**
 * Normalize TOML-emitted dotted-literal keys into nested structure.
 * Bun.TOML.parse treats `"default.modelRoles" = ...` as a literal top-level
 * key named `default.modelRoles`, not as nested `default.modelRoles`. The
 * emitter in cli/emit-settings-toml.ts uses this quoted-dotted form for
 * roundtrip-safety; the loader must invert it before merging into runtime
 * settings that are looked up via parsePath/getByPath.
 */
function rawDeepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
	const result: RawSettings = { ...base };
	for (const key of Object.keys(overrides)) {
		const override = overrides[key];
		if (override === undefined) continue;
		const baseVal = base[key];
		if (
			override !== null &&
			typeof override === "object" &&
			!Array.isArray(override) &&
			baseVal !== null &&
			typeof baseVal === "object" &&
			!Array.isArray(baseVal)
		) {
			result[key] = rawDeepMerge(baseVal as RawSettings, override as RawSettings);
		} else {
			result[key] = override;
		}
	}
	return result;
}

export function normalizeDottedKeys(raw: RawSettings): RawSettings {
	const result: RawSettings = {};
	// Track which paths arrived as flat-quoted dotted keys vs nested-table keys, to fail-fast on collision.
	const flatQuotedPaths = new Set<string>();
	const nestedPaths = new Set<string>();
	for (const [key, value] of Object.entries(raw)) {
		const normalized =
			value !== null && typeof value === "object" && !Array.isArray(value)
				? normalizeDottedKeys(value as RawSettings)
				: value;
		const keyHasDot = key.includes(".");
		const segments = keyHasDot ? parsePath(key) : [key];
		const joinedPath = segments.join(".");
		if (keyHasDot) {
			if (nestedPaths.has(joinedPath)) {
				throw new Error(
					`Settings collision: path "${joinedPath}" defined as both nested table (e.g. [${segments[0]}] / ${segments.slice(1).join(".")}) and flat-quoted key ("${joinedPath}"). Pick one form and remove the other.`,
				);
			}
			flatQuotedPaths.add(joinedPath);
		} else if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
			// Track every nested leaf path under this key for collision detection
			const walk = (obj: RawSettings, prefix: string[]): void => {
				for (const [k, v] of Object.entries(obj)) {
					const path = [...prefix, k].join(".");
					if (flatQuotedPaths.has(path)) {
						throw new Error(
							`Settings collision: path "${path}" defined as both nested table and flat-quoted key ("${path}"). Pick one form and remove the other.`,
						);
					}
					nestedPaths.add(path);
					if (v !== null && typeof v === "object" && !Array.isArray(v)) {
						walk(v as RawSettings, [...prefix, k]);
					}
				}
			};
			walk(normalized as RawSettings, [key]);
		}
		const existing = getByPath(result, segments);
		if (
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing) &&
			normalized !== null &&
			typeof normalized === "object" &&
			!Array.isArray(normalized)
		) {
			setByPath(result, segments, rawDeepMerge(existing as RawSettings, normalized as RawSettings));
		} else {
			setByPath(result, segments, normalized);
		}
	}
	return result;
}

/**
 * Lift the emitter's synthetic `default.*` bucket to the root.
 * emit-settings-toml.ts wraps bare top-level keys (modelRoles, defaultThinkingLevel,
 * hideThinkingBlock, etc.) under a `default` prefix for presentation. This undoes
 * the wrap so `settings.get("model.roles")` resolves via the normal top-level path.
 */
export function liftSyntheticDefault(raw: RawSettings): RawSettings {
	const bucket = raw.default;
	if (bucket === null || bucket === undefined || typeof bucket !== "object" || Array.isArray(bucket)) {
		return raw;
	}
	const result: RawSettings = { ...raw };
	delete result.default;
	for (const [key, value] of Object.entries(bucket as RawSettings)) {
		if (value === undefined) continue;
		const existing = result[key];
		if (
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing) &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			result[key] = rawDeepMerge(existing as RawSettings, value as RawSettings);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function formatTomlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isTomlBareKeySafe(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(value);
}

function formatTomlKey(value: string): string {
	return isTomlBareKeySafe(value) ? value : formatTomlString(value);
}

function hasTomlEntries(record: Record<string, unknown>): boolean {
	return Object.entries(record).some(([, value]) => value !== undefined);
}

function isNonEmptyTomlRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		hasTomlEntries(value as Record<string, unknown>)
	);
}

function formatTomlValue(value: unknown): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
	if (typeof value === "string") return formatTomlString(value);
	if (value === null || value === undefined) return '""';
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every(item => item !== null && typeof item === "object" && !Array.isArray(item))) {
			if (value.length === 1) {
				return `[${formatTomlInlineRecord(value[0] as Record<string, unknown>)}]`;
			}
			const inner = value.map(item => `\t${formatTomlInlineRecord(item as Record<string, unknown>)},`).join("\n");
			return `[\n${inner}\n]`;
		}
		return `[${value.map(item => formatTomlValue(item)).join(", ")}]`;
	}
	if (typeof value === "object") {
		return formatTomlInlineRecord(value as Record<string, unknown>);
	}
	throw new Error(`Unsupported TOML value type: ${typeof value}`);
}

function formatTomlInlineRecord(record: Record<string, unknown>): string {
	const entries = Object.entries(record)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "{}";
	return `{ ${entries.map(([key, value]) => `${formatTomlKey(key)} = ${formatTomlValue(value)}`).join(", ")} }`;
}

function emitTomlTable(lines: string[], tablePath: string[], record: Record<string, unknown>): void {
	if (tablePath.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(`[${tablePath.join(".")}]`);
	}

	const entries = Object.entries(record)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	const scalarEntries = entries.filter(([, value]) => !isNonEmptyTomlRecord(value));
	const tableEntries = entries.filter(([, value]) => isNonEmptyTomlRecord(value));

	for (const [key, value] of scalarEntries) {
		lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
	}

	for (const [key, value] of tableEntries) {
		emitTomlTable(lines, [...tablePath, key], value as Record<string, unknown>);
	}
}

function renderRawSettingsToml(raw: RawSettings): string {
	const lines: string[] = [];
	const entries = Object.entries(raw)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	const scalarEntries = entries.filter(([, value]) => !isNonEmptyTomlRecord(value));
	const tableEntries = entries.filter(([, value]) => isNonEmptyTomlRecord(value));

	for (const [key, value] of scalarEntries) {
		lines.push(`${formatTomlKey(key)} = ${formatTomlValue(value)}`);
	}

	for (const [key, value] of tableEntries) {
		emitTomlTable(lines, [key], value as Record<string, unknown>);
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════
export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	/** Global settings from config.yml */
	#global: RawSettings = {};
	/** Project settings from .claude/settings.yml etc */
	#project: RawSettings = {};
	/** User-agent settings from ~/.agent/ohp-settings.toml (dominates config.yml per Carter's rule) */
	#user: RawSettings = {};
	#userConfigPath: string | null = null;
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, "config.yml");
		this.#persist = !options.inMemory;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, parsePath(key), value);
			}
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				throw error;
			},
		);
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		const segments = parsePath(path);
		const value = getByPath(this.#merged, segments);
		if (value !== undefined) {
			return value as SettingValue<P>;
		}
		return getDefault(path);
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = parsePath(path);
		const target = this.#userConfigPath ? this.#user : this.#global;
		setByPath(target, segments, value);
		this.#modified.add(path);
		this.#rebuildMerged();
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(value, prev);
		}
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const segments = parsePath(path);
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		const segments = parsePath(path);
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#modified.size > 0) {
			await this.#saveNow();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shell.path");
		return procmgr.getShellConfig(shell);
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = (this.#merged.edit as { modelVariants?: Record<string, string> })?.modelVariants;
		if (!variants) return null;
		for (const pattern in variants) {
			if (model.includes(pattern)) {
				const value = normalizeEditMode(variants[pattern]);
				if (value) {
					return value;
				}
			}
		}
		return null;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	/**
	 * Set a model role (helper for modelRoles record).
	 */
	setModelRole(role: ModelRole | string, modelId: string): void {
		const current = this.get("model.roles");
		this.set("model.roles", { ...current, [role]: modelId });
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles = this.get("model.roles");
		return roles[role];
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		return this.get("model.roles");
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const prev = this.get("model.roles");
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				prev[role] = modelId;
			}
		}
		this.override("model.roles", prev);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("discovery.disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		// Load user-agent TOML first to decide config.yml suppression.
		// Carter's rule: ~/.agent/ohp-settings.toml is authoritative at user level.
		// When present, it suppresses config.yml entirely (hard suppression).
		const userResult = await this.#loadUserAgentToml();
		this.#user = userResult.data;
		this.#userConfigPath = userResult.path;

		if (this.#persist) {
			// Open storage
			this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));

			// Migrate from legacy formats if needed
			await this.#migrateFromLegacy();

			if (userResult.path !== null) {
				logger.debug("Settings: using user-agent TOML as authoritative user-level store", {
					userAgentToml: userResult.path,
					configYml: this.#configPath,
				});
			} else {
				// No user-agent TOML: config.yml is the authoritative user-level source.
				this.#global = await this.#loadYaml(this.#configPath!);
			}
		}

		// Load project settings
		this.#project = await this.#loadProjectSettings();

		// Build merged view
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		try {
			const content = await Bun.file(filePath).text();
			const parsed = YAML.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {};
			}
			return this.#migrateRawSettings(parsed as RawSettings);
		} catch (error) {
			if (isEnoent(error)) return {};
			logger.warn("Settings: failed to load", { path: filePath, error: String(error) });
			return {};
		}
	}

	async #loadToml(filePath: string): Promise<RawSettings> {
		try {
			const content = await Bun.file(filePath).text();
			const parsed = Bun.TOML.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {};
			}
			const normalized = normalizeDottedKeys(parsed as RawSettings);
			const lifted = liftSyntheticDefault(normalized);
			return this.#migrateRawSettings(lifted);
		} catch (error) {
			if (isEnoent(error)) return {};
			logger.warn("Settings: failed to load user-agent TOML", { path: filePath, error: String(error) });
			return {};
		}
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			let merged: RawSettings = {};
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
				}
			}
			return this.#migrateRawSettings(merged);
		} catch {
			return {};
		}
	}

	async #loadUserAgentToml(): Promise<{ data: RawSettings; path: string | null }> {
		// Carter's rule: ~/.agent/ohp-settings.toml dominates other user-level
		// settings. When present, config.yml is suppressed at read time (see #load).
		const home = os.homedir();
		const candidates = [
			path.join(home, ".agent", "ohp-settings.toml"),
			path.join(home, ".agents", "ohp-settings.toml"),
		];
		for (const candidate of candidates) {
			try {
				const data = await this.#loadToml(candidate);
				if (Object.keys(data).length > 0 || (await Bun.file(candidate).exists())) {
					return { data, path: candidate };
				}
			} catch (error) {
				if (isEnoent(error)) continue;
				logger.warn("Settings: failed to load user-agent TOML", {
					path: candidate,
					error: String(error),
				});
			}
		}
		return { data: {}, path: null };
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		// Check if config.yml already exists
		try {
			await Bun.file(this.#configPath).text();
			return; // Already exists, no migration needed
		} catch (err) {
			if (!isEnoent(err)) return;
		}

		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed = JSON.parse(await Bun.file(settingsJsonPath).text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch {}
			}
		} catch {}

		// 2. Migrate from agent.db
		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch {}

		// 3. Write merged settings
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await Bun.write(this.#configPath, YAML.stringify(settings, null, 2));
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch {}
		}
	}

	/** Apply schema migrations to raw settings */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// ask.timeout: ms -> seconds (if value > 1000, it's old ms format)
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > 1000) {
				(raw.ask as Record<string, unknown>).timeout = Math.round(oldValue / 1000);
			}
		}

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				// Built-in defaults — just remove, let new defaults apply
				delete raw.theme;
			} else {
				// Custom theme — detect luminance to place in correct slot
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "worktree" : "none";
			}
			delete isolationObj.enabled;
		}

		return raw;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	#queueSave(): void {
		if (!this.#persist || (!this.#configPath && !this.#userConfigPath)) return;

		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#saveNow().catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	async #saveNow(): Promise<void> {
		const savePath = this.#userConfigPath ?? this.#configPath;
		if (!this.#persist || !savePath || this.#modified.size === 0) return;

		const modifiedPaths = [...this.#modified];
		const target = this.#userConfigPath ? this.#user : this.#global;
		this.#modified.clear();

		try {
			await withFileLock(savePath, async () => {
				const current = this.#userConfigPath ? await this.#loadToml(savePath) : await this.#loadYaml(savePath);

				for (const modPath of modifiedPaths) {
					const segments = parsePath(modPath);
					const value = getByPath(target, segments);
					setByPath(current, segments, value);
				}

				if (this.#userConfigPath) {
					this.#user = current;
					await Bun.write(savePath, renderRawSettingsToml(this.#user));
				} else {
					this.#global = current;
					await Bun.write(savePath, YAML.stringify(this.#global, null, 2));
				}
			});
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error), path: savePath });
			for (const p of modifiedPaths) {
				this.#modified.add(p);
			}
		}

		this.#rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#rebuildMerged(): void {
		let merged = this.#deepMerge({}, this.#global);
		merged = this.#deepMerge(merged, this.#user);
		merged = this.#deepMerge(merged, this.#project);
		merged = this.#deepMerge(merged, this.#overrides);
		this.#merged = merged;
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	"appearance.symbolPreset": value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value).catch(err => {
				logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
			});
		}
	},
	"appearance.colorBlindMode": value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value).catch(err => {
				logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
			});
		}
	},
	"display.tabWidth": value => {
		if (typeof value === "number") {
			setDefaultTabWidth(value);
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function _resetSettingsForTest(): void {
	globalInstance = null;
	globalInstancePromise = null;
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		const value = (globalInstance as unknown as Record<string | symbol, unknown>)[prop];
		if (typeof value === "function") {
			return value.bind(globalInstance);
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
