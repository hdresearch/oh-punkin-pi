import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@ohp/agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import awaitDescription from "../prompts/tools/await.md" with { type: "text" };
import type { ToolSession } from "./index";

const DEFAULT_TIMEOUT_SEC = 600;

const awaitSchema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Specific job IDs to wait for. If omitted, waits for any running job.",
		}),
	),
	timeoutSec: Type.Optional(
		Type.Number({
			description: `Wake-ceiling in seconds; the call returns even if no event fires. Default ${DEFAULT_TIMEOUT_SEC} (10min). Not cumulative — each invocation resets.`,
			minimum: 1,
		}),
	),
});

type AwaitParams = Static<typeof awaitSchema>;

type WakeReason = "job_event" | "pending_message" | "timeout" | "aborted" | "no_running_jobs";

interface AwaitResult {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

export interface AwaitToolDetails {
	jobs: AwaitResult[];
	wakeReason: WakeReason;
	timeoutSec: number;
}

export class AwaitTool implements AgentTool<typeof awaitSchema, AwaitToolDetails> {
	readonly name = "await_one";
	readonly label = "Await One";
	readonly description: string;
	readonly parameters = awaitSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(awaitDescription);
	}

	static createIf(session: ToolSession): AwaitTool | null {
		if (!session.settings.get("async.enabled")) return null;
		return new AwaitTool(session);
	}

	async execute(
		_toolCallId: string,
		params: AwaitParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AwaitToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AwaitToolDetails>> {
		const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs to poll." }],
				details: { jobs: [], wakeReason: "no_running_jobs", timeoutSec },
			};
		}

		const requestedIds = params.jobs;

		// Resolve which jobs to watch
		const jobsToWatch = requestedIds?.length
			? requestedIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			const message = requestedIds?.length
				? `No matching jobs found for IDs: ${requestedIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [], wakeReason: "no_running_jobs", timeoutSec },
			};
		}

		// If all watched jobs are already done, return immediately
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			return this.#buildResult(manager, jobsToWatch, "job_event", timeoutSec);
		}

		// Race: {job_event, pending_message, timeout, aborted}
		// Jobs are NOT cancelled on any of these outcomes — they keep running.
		let wakeReason: WakeReason = "timeout";
		const jobPromise = Promise.race(runningJobs.map(j => j.promise)).then(() => {
			wakeReason = "job_event";
		});
		const messagePromise = (this.session.waitForQueuedMessage?.(signal) ?? new Promise<void>(() => {})).then(() => {
			if (!signal?.aborted) wakeReason = "pending_message";
		});
		const timeoutPromise = new Promise<void>(resolve => {
			const handle = setTimeout(() => {
				wakeReason = "timeout";
				resolve();
			}, timeoutSec * 1000);
			handle.unref?.();
		});
		const racePromises: Promise<void>[] = [jobPromise, messagePromise, timeoutPromise];

		if (signal) {
			const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
			const onAbort = () => {
				wakeReason = "aborted";
				abortResolve();
			};
			if (signal.aborted) {
				wakeReason = "aborted";
				abortResolve();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			racePromises.push(abortPromise);
			try {
				await Promise.race(racePromises);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} else {
			await Promise.race(racePromises);
		}

		return this.#buildResult(manager, jobsToWatch, wakeReason, timeoutSec);
	}

	#buildResult(
		manager: NonNullable<ToolSession["asyncJobManager"]>,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
		wakeReason: WakeReason,
		timeoutSec: number,
	): AgentToolResult<AwaitToolDetails> {
		const now = Date.now();
		const jobResults: AwaitResult[] = jobs.map(j => ({
			id: j.id,
			type: j.type,
			status: j.status as AwaitResult["status"],
			label: j.label,
			durationMs: Math.max(0, now - j.startTime),
			...(j.resultText ? { resultText: j.resultText } : {}),
			...(j.errorText ? { errorText: j.errorText } : {}),
		}));

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];
		lines.push(`Wake reason: ${wakeReason}`);
		lines.push("");
		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { jobs: jobResults, wakeReason, timeoutSec },
		};
	}
}
