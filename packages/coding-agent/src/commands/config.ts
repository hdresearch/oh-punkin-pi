/**
 * Manage configuration settings.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg", "emit-toml"];

export default class Config extends Command {
	static description = "Manage configuration settings";

	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		layout: Flags.string({ description: "emit-toml layout", options: ["grouped", "flat"] }),
		"prefix-order": Flags.string({ description: "emit-toml prefix order", options: ["alpha", "priority"] }),
		"include-comments": Flags.boolean({ description: "Include comments in emitted TOML", allowNo: true }),
		"include-priority-header": Flags.boolean({
			description: "Include priority header in emitted TOML",
			allowNo: true,
		}),
		"group-bulk": Flags.boolean({ description: "Split hot vs more fields in grouped mode", allowNo: true }),
		"rename-providers": Flags.boolean({
			description: "Relabel providers as toolingProviders in emitted TOML",
			allowNo: true,
		}),
		"template-date": Flags.string({ description: "Template date suffix for emitted template artifact" }),
		"output-template": Flags.string({ description: "Path for emitted template TOML" }),
		"output-active": Flags.string({ description: "Path for emitted active TOML" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				layout: flags.layout as ConfigCommandArgs["flags"]["layout"],
				prefixOrder: flags["prefix-order"] as ConfigCommandArgs["flags"]["prefixOrder"],
				includeComments: flags["include-comments"],
				includePriorityHeader: flags["include-priority-header"],
				groupBulk: flags["group-bulk"],
				renameProviders: flags["rename-providers"],
				templateDate: flags["template-date"],
				outputTemplate: flags["output-template"],
				outputActive: flags["output-active"],
			},
		};

		await initTheme();
		await runConfigCommand(cmd);
	}
}
