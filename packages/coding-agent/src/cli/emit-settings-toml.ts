import { writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@ohp/utils";
import { getUi, type SettingPath, settings } from "../config/settings";
import { SETTINGS_SCHEMA } from "../config/settings-schema";

// ─────────────────────────────────────────────────────────────────────────────
// Lex-sort + run-group emitter.
//
// Algorithm:
//   1. Collect every (path, value) from SETTINGS_SCHEMA, sort lexicographically.
//   2. Run-group adjacent paths sharing the same first dot-segment.
//   3. Group of size >=2  -> emit `[prefix]` section header (blank line above).
//                            Each child emits its bare relative tail.
//      Group of size 1    -> emit the fully-qualified flat key (no header).
//   4. Arrays-of-objects always emit inline (`= [ {…}, {…} ]`).
//      Empty records emit as inline tables (`= {}`), but non-empty records emit as
//      nested TOML subtables (`[x.y]`) so multiline edits stay valid and editor-
//      friendly.
//      No `[[x]]` headers; nested `[x.y]` headers are used only for non-empty
//      record-valued settings.
//
// Live ~/.agent/ohp-settings.toml is NEVER written here. Emit only produces the
// dated reference template at ~/.agent/ohp-settings-template-YYYY-MM-DD.toml.
// User-level live config is sovereign; seed it once via `config init-xdg` then
// hand-edit. The legacy `outputActive` field on EmitTomlOptions is preserved
// for caller compat but ignored.
// ─────────────────────────────────────────────────────────────────────────────

export type EmitLayout = "grouped" | "flat";

export interface EmitTomlOptions {
	layout: EmitLayout;
	includeComments: boolean;
	templateDate: string;
	outputTemplate: string;
	/** @deprecated Live ohp-settings.toml is user-sovereign. This field is ignored. */
	outputActive: string;
}

interface SettingMeta {
	path: string;
	description: string;
	allowedValues?: readonly string[];
	defaultValue?: unknown;
	value: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOML value formatting
// ─────────────────────────────────────────────────────────────────────────────

function tomlEscape(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatScalar(value: unknown): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : '""';
	if (typeof value === "string") return `"${tomlEscape(value)}"`;
	if (Array.isArray(value)) return `[${value.map(item => formatScalar(item)).join(", ")}]`;
	if (value === null || value === undefined) return '""';
	throw new Error(`Unsupported scalar type: ${typeof value}`);
}

function isBareKeySafe(k: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(k);
}

function hasTomlEntries(record: Record<string, unknown>): boolean {
	return Object.entries(record).some(([, value]) => value !== undefined);
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		hasTomlEntries(value as Record<string, unknown>)
	);
}

function formatInlineRecord(record: Record<string, unknown>): string {
	const keys = Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort();
	if (keys.length === 0) return "{}";
	const parts = keys.map(k => `${isBareKeySafe(k) ? k : `"${tomlEscape(k)}"`} = ${formatValue(record[k])}`);
	return `{ ${parts.join(", ")} }`;
}

function formatInlineAoT(value: Array<Record<string, unknown>>): string {
	if (value.length === 0) return "[]";
	if (value.length === 1) return `[${formatInlineRecord(value[0])}]`;
	const inner = value.map(r => `\t${formatInlineRecord(r)},`).join("\n");
	return `[\n${inner}\n]`;
}

function formatValue(value: unknown): string {
	if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
		return formatInlineAoT(value as Array<Record<string, unknown>>);
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return formatInlineRecord(value as Record<string, unknown>);
	}
	return formatScalar(value);
}

function emitNestedRecord(lines: string[], tablePath: string[], record: Record<string, unknown>): void {
	const entries = Object.entries(record)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	const scalarEntries = entries.filter(([, value]) => !isNonEmptyRecord(value));
	const tableEntries = entries.filter(([, value]) => isNonEmptyRecord(value));

	for (const [key, value] of scalarEntries) {
		lines.push(`${isBareKeySafe(key) ? key : `"${tomlEscape(key)}"`} = ${formatValue(value)}`);
	}

	for (const [key, value] of tableEntries) {
		if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
		lines.push(`[${[...tablePath, key].join(".")}]`);
		emitNestedRecord(lines, [...tablePath, key], value as Record<string, unknown>);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Emit
// ─────────────────────────────────────────────────────────────────────────────

function collectSettings(): SettingMeta[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(key => {
		const definition = SETTINGS_SCHEMA[key];
		return {
			path: key,
			description: getUi(key)?.description ?? "",
			allowedValues: definition.type === "enum" ? definition.values : undefined,
			defaultValue: definition.default,
			value: settings.get(key),
		};
	});
}

function pushFileHeader(lines: string[], options: EmitTomlOptions): void {
	if (!options.includeComments) return;
	lines.push(`# ${APP_NAME.toUpperCase()} settings reference template`);
	lines.push("# Prefix-grouped by everything before the final dot; entries within a prefix are");
	lines.push("# sorted by final key segment. Non-empty record values emit as nested TOML tables.");
	lines.push("");
}

function shouldCommentDefaultValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(
			item => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
		);
	}
	return false;
}

function emitSettingComments(lines: string[], item: SettingMeta, includeComments: boolean): void {
	if (!includeComments) return;
	if (item.description) lines.push(`# ${item.description}`);
	if (item.defaultValue !== undefined && shouldCommentDefaultValue(item.defaultValue)) {
		lines.push(`# Default: ${formatValue(item.defaultValue)}`);
	}
	if (item.allowedValues && item.allowedValues.length > 0) {
		lines.push(`# Allowed values: ${item.allowedValues.map(value => JSON.stringify(value)).join(", ")}`);
	}
}

export function renderSettingsToml(items: SettingMeta[], options: EmitTomlOptions): string {
	const lines: string[] = [];
	pushFileHeader(lines, options);

	const groups = new Map<string, SettingMeta[]>();
	for (const item of items) {
		const dot = item.path.lastIndexOf(".");
		const prefix = item.path.slice(0, dot);
		const existing = groups.get(prefix);
		if (existing) {
			existing.push(item);
		} else {
			groups.set(prefix, [item]);
		}
	}

	const sortedPrefixes = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
	for (const prefix of sortedPrefixes) {
		const group = groups.get(prefix)!;
		group.sort((a, b) => {
			const aKey = a.path.slice(a.path.lastIndexOf(".") + 1);
			const bKey = b.path.slice(b.path.lastIndexOf(".") + 1);
			return aKey.localeCompare(bKey);
		});

		lines.push("");
		lines.push(`[${prefix}]`);

		const scalarItems = group.filter(item => !isNonEmptyRecord(item.value));
		const tableItems = group.filter(item => isNonEmptyRecord(item.value));

		for (const item of scalarItems) {
			emitSettingComments(lines, item, options.includeComments);
			const key = item.path.slice(item.path.lastIndexOf(".") + 1);
			lines.push(`${key} = ${formatValue(item.value)}`);
		}

		for (const item of tableItems) {
			if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
			emitSettingComments(lines, item, options.includeComments);
			lines.push(`[${item.path}]`);
			emitNestedRecord(lines, item.path.split("."), item.value as Record<string, unknown>);
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export async function emitSettingsToml(options: EmitTomlOptions): Promise<string> {
	const items = collectSettings();
	const content = renderSettingsToml(items, options);
	// Only write the dated reference template. The live file is user-sovereign.
	await writeFile(options.outputTemplate, content, "utf8");
	return content;
}

export function defaultEmitOptions(templateDate: string): EmitTomlOptions {
	const tplPath = path.join(os.homedir(), ".agent", `ohp-settings-template-${templateDate}.toml`);
	return {
		layout: "grouped",
		includeComments: true,
		templateDate,
		outputTemplate: tplPath,
		outputActive: tplPath, // legacy field; ignored by emitSettingsToml
	};
}
