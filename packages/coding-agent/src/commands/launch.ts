/**
 * Root command for the coding agent CLI.
 */

import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";

export default class Index extends Command {
	static description = "AI coding assistant";
	static hidden = true;

	static args = {
		messages: Args.string({
			description: "Messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "p-openai/gpt-5.2")',
		}),
		smol: Flags.string({
			description: "Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)",
		}),
		slow: Flags.string({
			description: "Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)",
		}),
		plan: Flags.string({
			description: "Plan model for architectural planning (or PI_PLAN_MODEL env)",
		}),
		provider: Flags.string({
			description: "Provider to use (legacy; prefer --model)",
		}),
		"api-key": Flags.string({
			description: "API key (defaults to env vars)",
		}),
		"system-prompt": Flags.string({
			description: "System prompt — inline text or file path (default: coding assistant prompt)",
		}),
		"append-system-prompt": Flags.string({
			description: "Append to the system prompt — inline text or file path",
		}),
		"allow-home": Flags.boolean({
			description: "Allow starting in ~ without auto-switching to a temp dir",
		}),
		mode: Flags.string({
			description: "Output mode: text (default), json, or rpc",
			options: ["text", "json", "rpc"],
		}),
		print: Flags.boolean({
			char: "p",
			description: "Non-interactive mode: process prompt and exit",
		}),
		continue: Flags.boolean({
			char: "c",
			description: "Continue previous session",
		}),
		resume: Flags.string({
			char: "r",
			description: "Resume a session (by ID prefix, path, or picker if omitted)",
		}),
		"session-dir": Flags.string({
			description: "Directory for session storage and lookup",
		}),
		"no-session": Flags.boolean({
			description: "Don't save session (ephemeral)",
		}),
		models: Flags.string({
			description: "Comma-separated model patterns for Ctrl+P cycling",
		}),
		"no-tools": Flags.boolean({
			description: "Disable all built-in tools",
		}),
		"no-lsp": Flags.boolean({
			description: "Disable LSP tools, formatting, and diagnostics",
		}),
		"no-pty": Flags.boolean({
			description: "Disable PTY-based interactive bash execution",
		}),
		tools: Flags.string({
			description: "Comma-separated list of tools to enable (default: all)",
		}),
		thinking: Flags.string({
			description: `Set thinking level: ${THINKING_EFFORTS.join(", ")}`,
			options: [...THINKING_EFFORTS],
		}),
		hook: Flags.string({
			description: "Load a hook/extension file (can be used multiple times)",
			multiple: true,
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		"no-skills": Flags.boolean({
			description: "Disable skills discovery and loading",
		}),
		skills: Flags.string({
			description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)",
		}),
		"no-rules": Flags.boolean({
			description: "Disable rules discovery and loading",
		}),
		export: Flags.string({
			description: "Export session file to HTML and exit",
		}),
		"list-models": Flags.string({
			description: "List available models (with optional fuzzy search)",
		}),
		"no-title": Flags.boolean({
			description: "Disable title auto-generation",
		}),
		fork: Flags.string({
			description: "Fork from an existing session",
		}),
		"provider-session-id": Flags.string({
			description: "Provider session ID for session continuity",
		}),
		"plugin-dir": Flags.string({
			description: "Additional plugin directory to load",
			multiple: true,
		}),
		"print-thoughts": Flags.boolean({
			description: "Include thinking/squiggle blocks in print mode output",
		}),
		cwd: Flags.string({
			char: "C",
			description: "Set working directory",
		}),
	};

	static examples = [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Pipe prompt via stdin (useful for large prompts)\n  cat prompt.txt | ${APP_NAME} -p --model opus`,
		`# System prompt from file\n  ${APP_NAME} -p --system-prompt ./my-system.md "What is 2+2?"`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.ohp/agent/sessions/--path--/session.jsonl`,
	];

	static strict = false;

	async run(): Promise<void> {
		const parsed = parseArgs(this.argv);
		await runRootCommand(parsed, this.argv);
	}
}
