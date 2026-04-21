/**
 * CarterKit Session Hook — integration point between CarterKit and AgentSession.
 *
 * Provides a small facade over runtime + turn-boundary logic so AgentSession can
 * wire CarterKit with minimal coupling.
 */

import type { AgentMessage, AgentTool } from "@ohp/agent-core";
import type { TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { CarterKitRuntime, PushDownToolDef } from "./runtime.js";
import {
	COT_REPLAY_TOOL,
	enrichCompactionInput,
	HANDLE_TOOLS_PROMPT,
	initRuntime,
	interceptToolCall,
	interceptToolResult,
	onTurnEnd,
	PUSHDOWN_TOOLS,
	shutdownRuntime,
} from "./runtime.js";
import {
	onTurnEnd as boundaryTurnEnd,
	onTurnStart as boundaryTurnStart,
	currentTurnStartMessage,
	initTurnBoundaryState,
	injectTurnBoundaries,
	type TurnBoundaryState,
	type TurnEndMessage,
	type TurnStartMessage,
} from "./turn-boundary.js";
import type { HandleId } from "./types.js";

export interface CarterKitHook {
	readonly runtime: CarterKitRuntime;

	beforeToolCall(
		toolName: string,
		args: unknown,
	): {
		skipResult: string | undefined;
		handleId: HandleId | undefined;
	};

	afterToolResult(handleId: HandleId | undefined, resultText: string): string;

	turnEnd(message: AgentMessage): void;
	systemPromptAddition(): string;
	enrichCompaction(messages: readonly AgentMessage[]): string;
	getTools(): AgentTool[];
	shutdown(): void;

	initializeTurnCounterFromEntries(entries: Array<{ type: string; turnNumber?: number }>): void;
	onAssistantTurnStart(): void;
	currentTurnStartMessage(): TurnStartMessage | undefined;
	onAssistantTurnEnd(turnMessages: readonly AgentMessage[]): [TurnStartMessage, TurnEndMessage];
	injectBoundaries(
		messages: AgentMessage[],
		turnStartIndex: number,
		turnEndIndex: number,
		turnStart: TurnStartMessage,
		turnEnd: TurnEndMessage,
	): AgentMessage[];
	readonly currentTurnSigil: string | undefined;
	readonly currentTurnNonce: string | undefined;
}

export function createCarterKitHook(storePath: string | undefined, sessionId: string): CarterKitHook {
	const rt = initRuntime(storePath, sessionId);
	const boundaryState: TurnBoundaryState = initTurnBoundaryState();

	return {
		runtime: rt,

		initializeTurnCounterFromEntries(entries: Array<{ type: string; turnNumber?: number }>): void {
			let maxTurn = 0;
			for (const entry of entries) {
				if (entry.type === "turn_boundary" && entry.turnNumber !== undefined) {
					maxTurn = Math.max(maxTurn, entry.turnNumber);
				}
			}
			boundaryState.currentTurn = maxTurn;
		},

		onAssistantTurnStart(): void {
			boundaryTurnStart(boundaryState);
		},

		currentTurnStartMessage(): TurnStartMessage | undefined {
			return currentTurnStartMessage(boundaryState);
		},

		onAssistantTurnEnd(turnMessages: readonly AgentMessage[]): [TurnStartMessage, TurnEndMessage] {
			return boundaryTurnEnd(boundaryState, turnMessages);
		},

		injectBoundaries(
			messages: AgentMessage[],
			turnStartIndex: number,
			turnEndIndex: number,
			turnStart: TurnStartMessage,
			turnEnd: TurnEndMessage,
		): AgentMessage[] {
			return injectTurnBoundaries(messages, turnStartIndex, turnEndIndex, turnStart, turnEnd);
		},

		get currentTurnSigil(): string | undefined {
			return boundaryState.currentSigil;
		},

		get currentTurnNonce(): string | undefined {
			return boundaryState.currentNonce;
		},

		beforeToolCall(toolName: string, args: unknown) {
			const intercept = interceptToolCall(rt, toolName, args);
			switch (intercept.tag) {
				case "SkipExecution":
					return { skipResult: intercept.resultText, handleId: undefined };
				case "ExecuteAndCapture":
					return { skipResult: undefined, handleId: intercept.handleId };
			}
		},

		afterToolResult(handleId: HandleId | undefined, resultText: string) {
			if (!handleId) return resultText;
			return interceptToolResult(rt, handleId, resultText);
		},

		turnEnd(message: AgentMessage) {
			onTurnEnd(rt, message);
		},

		systemPromptAddition() {
			return HANDLE_TOOLS_PROMPT;
		},

		enrichCompaction(messages: readonly AgentMessage[]) {
			return enrichCompactionInput(rt, messages);
		},

		getTools() {
			const allToolDefs = [...PUSHDOWN_TOOLS, COT_REPLAY_TOOL];
			return allToolDefs.map(def => pushDownToolToAgentTool(def, rt));
		},

		shutdown() {
			shutdownRuntime(rt);
		},
	};
}

function pushDownToolToAgentTool(def: PushDownToolDef, rt: CarterKitRuntime): AgentTool {
	const props: Record<string, TSchema> = {};
	for (const [key, prop] of Object.entries(def.parameters.properties)) {
		if (prop.type === "number") {
			props[key] = Type.Number({ description: prop.description });
		} else {
			props[key] = Type.String({ description: prop.description });
		}
	}
	const schema = Type.Object(props);

	return {
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: schema,
		async execute(_toolCallId: string, params: any, _signal?: AbortSignal, _onUpdate?: any) {
			const result = def.execute(rt, params);
			return {
				content: [{ type: "text", text: result }],
				details: {},
			};
		},
	};
}
