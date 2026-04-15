/**
 * Config CLI command handlers.
 *
 * Handles `omp config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import { APP_NAME, getAgentDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	type SettingPath,
	Settings,
	type SettingValue,
	settings,
} from "../config/settings";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import { theme } from "../modes/theme/theme";
import { initXdg } from "./commands/init-xdg";
import { defaultEmitOptions, emitSettingsToml, type EmitLayout, type PrefixOrder } from "./emit-settings-toml";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg" | "emit-toml";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
		layout?: EmitLayout;
		prefixOrder?: PrefixOrder;
		includeComments?: boolean;
		includePriorityHeader?: boolean;
		groupBulk?: boolean;
		renameProviders?: boolean;
		templateDate?: string;
		outputTemplate?: string;
		outputActive?: string;
	};
}
// =============================================================================
// Setting Filtering
// =============================================================================

type CliSettingDef = {
	path: SettingPath;
	type: string;
	description: string;
	tab: string;
};

const ALL_SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	if (!(path in SETTINGS_SCHEMA)) return undefined;
	const key = path as SettingPath;
	const ui = getUi(key);
	return {
		path: key,
		type: getType(key),
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
	};
}

/** Get available values for a setting */
function getSettingValues(def: CliSettingDef): readonly string[] | undefined {
	if (def.type === "enum") {
		return getEnumValues(def.path);
	}
	return undefined;
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "emit-toml"];

/**
 * Parse config subcommand arguments.
 * Returns undefined if not a config command.
 */
export function parseConfigArgs(args: string[]): ConfigCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "config") {
		return undefined;
	}

	if (args.length < 2 || args[1] === "--help" || args[1] === "-h") {
		return { action: "list", flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as ConfigAction)) {
		console.error(chalk.red(`Unknown config command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: ConfigCommandArgs = {
		action: action as ConfigAction,
		flags: {},
	};

	const positionalArgs: string[] = [];
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--include-comments") {
			result.flags.includeComments = true;
		} else if (arg === "--no-include-comments") {
			result.flags.includeComments = false;
		} else if (arg === "--include-priority-header") {
			result.flags.includePriorityHeader = true;
		} else if (arg === "--no-include-priority-header") {
			result.flags.includePriorityHeader = false;
		} else if (arg === "--group-bulk") {
			result.flags.groupBulk = true;
		} else if (arg === "--no-group-bulk") {
			result.flags.groupBulk = false;
		} else if (arg === "--rename-providers") {
			result.flags.renameProviders = true;
		} else if (arg === "--no-rename-providers") {
			result.flags.renameProviders = false;
		} else if (arg === "--layout") {
			result.flags.layout = args[++i] as EmitLayout | undefined;
		} else if (arg === "--prefix-order") {
			result.flags.prefixOrder = args[++i] as PrefixOrder | undefined;
		} else if (arg === "--template-date") {
			result.flags.templateDate = args[++i];
		} else if (arg === "--output-template") {
			result.flags.outputTemplate = args[++i];
		} else if (arg === "--output-active") {
			result.flags.outputActive = args[++i];
		} else if (!arg.startsWith("-")) {
			positionalArgs.push(arg);
		}
	}

	if (positionalArgs.length > 0) {
		result.key = positionalArgs[0];
	}
	if (positionalArgs.length > 1) {
		result.value = positionalArgs.slice(1).join(" ");
	}

	return result;
}

// =============================================================================
// Value Formatting
// =============================================================================

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = getSettingValues(def);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Schema-Driven Value Parsing
// =============================================================================

function parseAndSetValue(path: SettingPath, rawValue: string): void {
	const schemaType = getType(path);
	let parsedValue: unknown;

	const trimmed = rawValue.trim();
	switch (schemaType) {
		case "boolean": {
			const lower = trimmed.toLowerCase();
			if (["true", "1", "yes", "on"].includes(lower)) parsedValue = true;
			else if (["false", "0", "no", "off"].includes(lower)) parsedValue = false;
			else throw new Error(`Invalid boolean value: ${rawValue}. Use true/false, yes/no, on/off, or 1/0`);
			break;
		}
		case "number":
			parsedValue = Number(trimmed);
			if (!Number.isFinite(parsedValue)) throw new Error(`Invalid number: ${rawValue}`);
			break;
		case "enum": {
			const valid = getEnumValues(path);
			if (valid && !valid.includes(trimmed)) {
				throw new Error(`Invalid value: ${rawValue}. Valid values: ${valid.join(", ")}`);
			}
			parsedValue = trimmed;
			break;
		}
		case "array": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		case "record": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		default:
			parsedValue = trimmed;
	}

	settings.set(path, parsedValue as SettingValue<typeof path>);
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	await Settings.init();

	switch (cmd.action) {
		case "list":
			handleList(cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
		case "emit-toml":
			await handleEmitToml(cmd.flags);
			break;
	}
}

function handleList(flags: { json?: boolean }): void {
	const defs = ALL_SETTING_PATHS.map(path => findSettingDef(path)).filter((def): def is CliSettingDef => !!def);

	if (flags.json) {
		const result: Record<string, { value: unknown; type: string; description: string }> = {};
		for (const def of defs) {
			result[def.path] = {
				value: settings.get(def.path),
				type: def.type,
				description: def.description,
			};
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			const value = settings.get(def.path);
			const valueStr = formatValue(value);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const value = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value, type: def.type, description: def.description }, null, 2));
		return;
	}

	console.log(formatValue(value));
}

async function handleSet(key: string | undefined, value: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	try {
		parseAndSetValue(def.path, value);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	const newValue = settings.get(def.path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: newValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.path} = ${formatValue(newValue)}`));
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const path = def.path as SettingPath;
	const defaultValue = getDefault(path);
	settings.set(path, defaultValue as SettingValue<typeof path>);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: defaultValue }));
	} else {
		console.log(chalk.green(`${theme.status.success} Reset ${def.path} to ${formatValue(defaultValue)}`));
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}

async function handleEmitToml(flags: ConfigCommandArgs["flags"]): Promise<void> {
	const options = defaultEmitOptions(flags.templateDate ?? new Date().toISOString().slice(0, 10));
	options.layout = flags.layout ?? options.layout;
	options.prefixOrder = flags.prefixOrder ?? options.prefixOrder;
	options.includeComments = flags.includeComments ?? options.includeComments;
	options.includePriorityHeader = flags.includePriorityHeader ?? options.includePriorityHeader;
	options.groupBulk = flags.groupBulk ?? options.groupBulk;
	options.renameProviders = flags.renameProviders ?? options.renameProviders;
	options.outputTemplate = flags.outputTemplate ?? options.outputTemplate;
	options.outputActive = flags.outputActive ?? options.outputActive;
	await emitSettingsToml(options);
	console.log(chalk.green(`${theme.status.success} Wrote ${options.outputTemplate}`));
	console.log(chalk.green(`${theme.status.success} Wrote ${options.outputActive}`));
}

// =============================================================================
// Help
// =============================================================================

export function printConfigHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} config`)} - Manage settings

${chalk.bold("Commands:")}
  list               List all settings with current values
  get <key>          Get a specific setting value
  set <key> <value>  Set a setting value
  reset <key>        Reset a setting to its default value
  path               Print the config directory path
  init-xdg           Initialize XDG Base Directory structure
  emit-toml          Emit ergonomic TOML reference files from live settings

${chalk.bold("Options:")}
  --json             Output as JSON

${chalk.bold("Where real settings live:")}
  Native project settings: .ohp/settings.toml
  Reference artifacts:     ~/.agent/ohp-settings.toml
                           ~/.agent/ohp-settings-template-YYYY-MM-DD.toml

${chalk.bold("emit-toml options:")}
  --layout grouped|flat
  --prefix-order alpha|priority
  --include-comments / --no-include-comments
  --include-priority-header / --no-include-priority-header
  --group-bulk / --no-group-bulk
  --rename-providers / --no-rename-providers
  --template-date YYYY-MM-DD
  --output-template <path>
  --output-active <path>

${chalk.bold("Examples:")}
  ${APP_NAME} config list
  ${APP_NAME} config get theme
  ${APP_NAME} config set theme catppuccin-mocha
  ${APP_NAME} config set compaction.enabled false
  ${APP_NAME} config set defaultThinkingLevel medium
  ${APP_NAME} config reset steeringMode
  ${APP_NAME} config list --json
  ${APP_NAME} config init-xdg
  ${APP_NAME} config emit-toml
  ${APP_NAME} config emit-toml --prefix-order priority --output-template ~/.agent/ohp-settings-template-2026-04-13.toml --output-active ~/.agent/ohp-settings.toml

${chalk.bold("Boolean Values:")}
  true, false, yes, no, on, off, 1, 0
`);
}
