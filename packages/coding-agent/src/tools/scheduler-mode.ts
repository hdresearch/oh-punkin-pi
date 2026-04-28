import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@ohp/agent-core";
import { StringEnum } from "@ohp/ai";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import setSchedulerModeDescription from "../prompts/tools/set-scheduler-mode.md" with { type: "text" };

export type SchedulerMode =
	| { tag: "eager_beaver"; source?: SchedulerModeSource }
	| {
			tag: "co_design";
			reason: CoDesignReason;
			message?: string;
			otherReason?: string;
			source?: SchedulerModeSource;
	  };

export type SchedulerModeSource = "model_tool" | "user_toggled" | "harness";

export type CoDesignReason =
	| "needs_user_choice"
	| "ambiguous_requirements"
	| "design_review"
	| "risk_boundary"
	| "blocked"
	| "waiting_user_feedback"
	| "other";

export interface SchedulerModeToolDetails {
	mode: SchedulerMode;
}

const CoDesignReasonEnum = StringEnum(
	[
		"needs_user_choice",
		"ambiguous_requirements",
		"design_review",
		"risk_boundary",
		"blocked",
		"waiting_user_feedback",
		"other",
	] as const,
	{ description: "Why autonomous continuation should yield to Carter" },
);

const setSchedulerModeSchema = Type.Object({
	mode: Type.Literal("co_design", {
		description: "Only co_design is model-settable. Carter/harness exits co_design.",
	}),
	reason: CoDesignReasonEnum,
	message: Type.Optional(Type.String({ description: "Short user-facing explanation of what input is needed" })),
	otherReason: Type.Optional(Type.String({ description: "Free-text explanation when reason is other" })),
});

type SetSchedulerModeParams = Static<typeof setSchedulerModeSchema>;

export class SetSchedulerModeTool implements AgentTool<typeof setSchedulerModeSchema, SchedulerModeToolDetails> {
	readonly name = "set_scheduler_mode";
	readonly label = "Set Scheduler Mode";
	readonly description: string;
	readonly parameters = setSchedulerModeSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	constructor(private readonly session: { setSchedulerMode?: (mode: SchedulerMode) => void }) {
		this.description = renderPromptTemplate(setSchedulerModeDescription);
	}

	async execute(
		_toolCallId: string,
		params: SetSchedulerModeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SchedulerModeToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SchedulerModeToolDetails>> {
		const otherReason = params.reason === "other" ? params.otherReason?.trim() || undefined : undefined;
		const mode: SchedulerMode = {
			tag: "co_design",
			reason: params.reason,
			message: params.message,
			otherReason,
			source: "model_tool",
		};
		this.session.setSchedulerMode?.(mode);
		const reasonText = otherReason ? `${params.reason}:${otherReason}` : params.reason;
		const message = params.message ? `: ${params.message}` : "";
		return {
			content: [{ type: "text", text: `Scheduler mode set to co_design (${reasonText})${message}` }],
			details: { mode },
		};
	}
}
