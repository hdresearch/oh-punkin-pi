/**
 * CarterKit Session Hook — integration point between CarterKit and AgentSession.
 *
 * Rather than invasively patching agent-session.ts, this module
 * provides hook functions that get called from strategic points
 * in the agent lifecycle.
 *
 * The session creates a CarterKitHook, then calls its methods at the
 * appropriate lifecycle points. Minimal coupling.
 *
 * data CarterKitHook = CarterKitHook
 *   { hookRuntime :: CarterKitRuntime
 *   , hookOnToolCall :: Text -> Value -> IO (Maybe Text)  -- intercept
 *   , hookOnToolResult :: Text -> Text -> IO Text          -- capture
 *   , hookOnTurnEnd :: AgentMessage -> IO ()               -- CoT capture
 *   , hookSystemPromptAddition :: IO (Maybe Text)          -- pressure warning
 *   , hookCompactionEnrich :: [AgentMessage] -> IO Text    -- CoT for compaction
 *   }
 */

import type { AgentMessage, AgentTool } from "@punkin-pi/agent-core";
import type { Message, TurnStartMessage, TurnEndMessage } from "@punkin-pi/ai";
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
	pressureWarning,
	shutdownRuntime,
} from "./runtime.js";
import {
	type SquiggleState,
	initSquiggleState,
	appendSquiggleContent,
	setSquiggleTurn,
	createSquiggleTools,
} from "./squiggle-tools.js";
import {
	type TurnBoundaryState,
	initTurnBoundaryState,
	onTurnStart as boundaryTurnStart,
	onTurnEnd as boundaryTurnEnd,
} from "./turn-boundary.js";
import { mkOpenBracket, type TurnBracketState } from "./turn-bracket.js";
import type { HandleId } from "./types.js";

// ============================================================================
// Hook state
// ============================================================================

export interface CarterKitHook {
	readonly runtime: CarterKitRuntime;

	/**
	 * Called before a tool executes.
	 * Returns replacement result text if cached (skip execution),
	 * or undefined to proceed with normal execution.
	 * Also returns the handleId for result capture.
	 */
	beforeToolCall(
		toolName: string,
		args: unknown,
	): {
		skipResult: string | undefined;
		handleId: HandleId | undefined;
	};

	/**
	 * Called after a tool executes.
	 * Captures result to store, may replace with handle summary.
	 */
	afterToolResult(
		handleId: HandleId | undefined,
		resultText: string,
		contextTokens: number,
		contextWindow: number,
	): string;

	/**
	 * Called at end of each turn. Captures CoT.
	 */
	turnEnd(message: AgentMessage): void;

	/**
	 * Returns system prompt addition (pressure warning + CarterKit instructions).
	 */
	systemPromptAddition(contextTokens: number, contextWindow: number): string;

	/**
	 * Enrich compaction input with stored CoT.
	 */
	enrichCompaction(messages: readonly AgentMessage[]): string;

	/**
	 * Get the push-down DSL tools to register with the agent.
	 */
	getTools(): AgentTool[];

	/**
	 * Shutdown and persist.
	 */
	shutdown(): void;

	// ========================================================================
	// Turn bracket support
	// ========================================================================

	/**
	 * Called at turn start. Generates bracket state and returns open tag for prefill.
	 */
	turnStart(turnIndex: number): TurnBracketState;

	/**
	 * Current bracket state (valid during turn).
	 */
	readonly currentBracket: TurnBracketState;

	// ========================================================================
	// Turn boundary support (TurnStartMessage / TurnEndMessage)
	// ========================================================================

	/**
	 * Called when assistant turn begins. Records start time, assigns sigil/nonce.
	 */
	onAssistantTurnStart(): void;

	/**
	 * Called when assistant turn completes. Returns boundary messages to inject.
	 */
	onAssistantTurnEnd(turnMessages: readonly Message[]): [TurnStartMessage, TurnEndMessage];

	/**
	 * Current turn's sigil (valid during turn, undefined between turns).
	 */
	readonly currentTurnSigil: string | undefined;

	/**
	 * Current turn's nonce (valid during turn, undefined between turns).
	 */
	readonly currentTurnNonce: string | undefined;

	// ========================================================================
	// Squiggle support
	// ========================================================================

	/**
	 * Append content to current squiggle buffer (call as model generates).
	 */
	appendSquiggleContent(content: string): void;

	/**
	 * Get squiggle state for inspection.
	 */
	readonly squiggleState: SquiggleState;
}

// ============================================================================
// Create hook
// ============================================================================

export function createCarterKitHook(storePath: string | undefined, sessionId: string): CarterKitHook {
	const rt = initRuntime(storePath, sessionId);

	// Turn bracket state - initialized on first turnStart call
	let _currentBracket: TurnBracketState = mkOpenBracket(0);

	// Turn boundary state
	const _boundaryState: TurnBoundaryState = initTurnBoundaryState();

	// Squiggle state
	const _squiggleState: SquiggleState = initSquiggleState("strict");

	return {
		runtime: rt,

		// Turn bracket methods (legacy, for prefill approach)
		turnStart(turnIndex: number): TurnBracketState {
			_currentBracket = mkOpenBracket(turnIndex);
			// Also sync squiggle turn
			setSquiggleTurn(_squiggleState, turnIndex);
			return _currentBracket;
		},

		get currentBracket(): TurnBracketState {
			return _currentBracket;
		},

		// Turn boundary methods (new, structural messages)
		onAssistantTurnStart(): void {
			boundaryTurnStart(_boundaryState);
			setSquiggleTurn(_squiggleState, _boundaryState.currentTurn);
		},

		onAssistantTurnEnd(turnMessages: readonly Message[]): [TurnStartMessage, TurnEndMessage] {
			return boundaryTurnEnd(_boundaryState, turnMessages);
		},

		get currentTurnSigil(): string | undefined {
			return _boundaryState.currentSigil;
		},

		get currentTurnNonce(): string | undefined {
			return _boundaryState.currentNonce;
		},

		// Squiggle methods
		appendSquiggleContent(content: string): void {
			appendSquiggleContent(_squiggleState, content);
		},

		get squiggleState(): SquiggleState {
			return _squiggleState;
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

		afterToolResult(
			handleId: HandleId | undefined,
			resultText: string,
			contextTokens: number,
			contextWindow: number,
		) {
			if (!handleId) return resultText;
			return interceptToolResult(rt, handleId, resultText, contextTokens, contextWindow);
		},

		turnEnd(message: AgentMessage) {
			onTurnEnd(rt, message);
		},

		systemPromptAddition(contextTokens: number, contextWindow: number) {
			const parts: string[] = [HANDLE_TOOLS_PROMPT];
			const warning = pressureWarning(contextTokens, contextWindow);
			if (warning) parts.push(warning);
			return parts.join("\n\n");
		},

		enrichCompaction(messages: readonly AgentMessage[]) {
			return enrichCompactionInput(rt, messages);
		},

		getTools() {
			const allToolDefs = [...PUSHDOWN_TOOLS, COT_REPLAY_TOOL];
			const pushDownTools = allToolDefs.map((def) => pushDownToolToAgentTool(def, rt));
			// DISABLED: squiggle tools not enabled yet
			// const squiggleTools = createSquiggleTools(_squiggleState);
			// return [...pushDownTools, ...squiggleTools];
			return pushDownTools;
		},

		shutdown() {
			shutdownRuntime(rt);
		},
	};
}

// ============================================================================
// Convert PushDownToolDef to AgentTool
// ============================================================================

function pushDownToolToAgentTool(def: PushDownToolDef, rt: CarterKitRuntime): AgentTool {
	// Build TypeBox schema from the simple parameter definition
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
