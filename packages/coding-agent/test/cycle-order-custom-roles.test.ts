import { describe, expect, test } from "bun:test";
import { Settings } from "@ohp/coding-agent/config/settings";

describe("cycleOrder with custom roles", () => {
	test("cycleOrder setting accepts custom role names", () => {
		const settings = Settings.isolated({
			"model.cycleOrder": ["smol", "custom-fast", "default"],
		});
		expect(settings.get("model.cycleOrder")).toEqual(["smol", "custom-fast", "default"]);
	});

	test("cycleOrder falls back to default when not set", () => {
		const settings = Settings.isolated({});
		expect(settings.get("model.cycleOrder")).toEqual(["smol", "default", "slow"]);
	});

	test("modelTags can define custom role display info", () => {
		const settings = Settings.isolated({
			"model.tags": {
				"custom-fast": {
					name: "Fast Custom",
					color: "warning",
				},
			},
		});
		const modelTags = settings.get("model.tags") as Record<string, any>;
		expect(modelTags["custom-fast"]).toEqual({
			name: "Fast Custom",
			color: "warning",
		});
	});
});
