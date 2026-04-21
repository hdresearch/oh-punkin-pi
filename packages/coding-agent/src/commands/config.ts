/**
 * Manage configuration settings.
 */
import { Args, Command, Flags } from "@ohp/utils/cli";
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
		"include-comments": Flags.boolean({ description: "Include comments in emitted TOML", allowNo: true }),
		"template-date": Flags.string({ description: "Template date suffix for emitted template artifact" }),
		"output-template": Flags.string({ description: "Path for emitted template TOML" }),
		"output-active": Flags.string({ description: "DEPRECATED: ignored. Live ohp-settings.toml is user-sovereign." }),
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
				includeComments: flags["include-comments"],
				templateDate: flags["template-date"],
				outputTemplate: flags["output-template"],
				outputActive: flags["output-active"],
			},
		};

		await initTheme();
		await runConfigCommand(cmd);
	}
}
