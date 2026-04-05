/**
 * Squiggle tools for model-initiated visible reasoning blocks.
 *
 * These tools let the model create bracketed reasoning sections that persist
 * across turns and are visible in the conversation history.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { BracketId } from "@oh-my-pi/pi-ai";
import { closeSquiggleBracket, openSquiggleBracket } from "@oh-my-pi/pi-ai/role-boundary";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

export interface OpenSquiggleDetails {
	marker: string;
	bracketId: BracketId;
}

export interface CloseSquiggleDetails {
	marker: string;
}

const openSquiggleSchema = Type.Object({});

const closeSquiggleSchema = Type.Object({
	nonce: Type.String({ description: "Nonce from open_squiggle result" }),
	sigil: Type.String({ description: "Sigil from open_squiggle result" }),
});

type OpenSquiggleParams = Static<typeof openSquiggleSchema>;
type CloseSquiggleParams = Static<typeof closeSquiggleSchema>;

export class OpenSquiggleTool implements AgentTool<typeof openSquiggleSchema, OpenSquiggleDetails> {
	readonly name = "open_squiggle";
	readonly label = "Open Squiggle";
	readonly description =
		"Open a visible reasoning block. Returns an opening bracket marker with sigil and nonce. " +
		"Use close_squiggle with the returned nonce and sigil to close it.";
	readonly parameters = openSquiggleSchema;

	// biome-ignore lint/complexity/noUselessConstructor: required by ToolFactory pattern
	constructor(_session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: OpenSquiggleParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<OpenSquiggleDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<OpenSquiggleDetails>> {
		const { marker, bracketId } = openSquiggleBracket();
		// Model sees only the structural open — sigil+nonce stay in details for harness/renderer.
		// This prevents the model from learning the codebook on the same turn.
		return {
			content: [{ type: "text", text: "{" }],
			details: { marker, bracketId },
		};
	}
}

export class CloseSquiggleTool implements AgentTool<typeof closeSquiggleSchema, CloseSquiggleDetails> {
	readonly name = "close_squiggle";
	readonly label = "Close Squiggle";
	readonly description =
		"Close a visible reasoning block. Provide the nonce and sigil from the open_squiggle result " +
		"to generate the matching closing marker.";
	readonly parameters = closeSquiggleSchema;

	// biome-ignore lint/complexity/noUselessConstructor: required by ToolFactory pattern
	constructor(_session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CloseSquiggleParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CloseSquiggleDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CloseSquiggleDetails>> {
		const bracketId: BracketId = { sigil: params.sigil, nonce: params.nonce };
		const marker = closeSquiggleBracket(bracketId);
		// Model sees only the structural close — sigil+nonce stay in details.
		return {
			content: [{ type: "text", text: "}" }],
			details: { marker },
		};
	}
}
