import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@ohp/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@ohp/coding-agent/slash-commands/builtin-registry";
import type { SchedulerMode } from "@ohp/coding-agent/tools/scheduler-mode";

function createRuntime(initialMode: SchedulerMode = { tag: "eager_beaver", source: "harness" }) {
	let mode = initialMode;
	const setText = vi.fn();
	const showStatus = vi.fn();
	const setSchedulerMode = vi.fn((next: SchedulerMode) => {
		mode = next;
	});
	const invalidate = vi.fn();
	const updateEditorTopBorder = vi.fn();
	const requestRender = vi.fn();
	return {
		setText,
		showStatus,
		setSchedulerMode,
		invalidate,
		updateEditorTopBorder,
		requestRender,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				session: {
					getSchedulerMode: () => mode,
					setSchedulerMode,
				} as unknown as InteractiveModeContext["session"],
				showStatus,
				statusLine: { invalidate } as unknown as InteractiveModeContext["statusLine"],
				updateEditorTopBorder,
				ui: { requestRender } as unknown as InteractiveModeContext["ui"],
			} as unknown as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/scheduler slash command", () => {
	it("sets eager mode via /eager", async () => {
		const harness = createRuntime({ tag: "co_design", reason: "design_review", source: "model_tool" });

		const handled = await executeBuiltinSlashCommand("/eager", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setSchedulerMode).toHaveBeenCalledWith({ tag: "eager_beaver", source: "user_toggled" });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("sets co-design mode without a blocking reason gate", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/co_design", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setSchedulerMode).toHaveBeenCalledWith({
			tag: "co_design",
			reason: "other",
			otherReason: undefined,
			message: undefined,
			source: "user_toggled",
		});
	});

	it("sets co-design mode via /collab", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setSchedulerMode).toHaveBeenCalledWith({
			tag: "co_design",
			reason: "other",
			otherReason: undefined,
			message: undefined,
			source: "user_toggled",
		});
	});

	it("sets co-design mode via /interactive_collab", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/interactive_collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setSchedulerMode).toHaveBeenCalledWith({
			tag: "co_design",
			reason: "other",
			otherReason: undefined,
			message: undefined,
			source: "user_toggled",
		});
	});

	it("sets co-design mode via /interactive-collab", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/interactive-collab", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setSchedulerMode).toHaveBeenCalledWith({
			tag: "co_design",
			reason: "other",
			otherReason: undefined,
			message: undefined,
			source: "user_toggled",
		});
	});

	it("does not reserve /codesign as a scheduler alias", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/codesign", harness.runtime);

		expect(handled).toBe(false);
		expect(harness.setSchedulerMode).not.toHaveBeenCalled();
	});

	it("does not reserve /co-design as a scheduler command", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/co-design", harness.runtime);

		expect(handled).toBe(false);
		expect(harness.setSchedulerMode).not.toHaveBeenCalled();
	});
});
