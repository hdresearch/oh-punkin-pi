import { Container, Text } from "@punkin-pi/tui";
import type { TurnStartMessage, TurnEndMessage } from "@punkin-pi/ai";
import { renderTurnStart, renderTurnEnd } from "../../../core/carter_kit/turn-boundary.js";
import { theme } from "../theme/theme.js";

/**
 * Component that renders a turn boundary (start or end).
 * Uses unicode box drawing, sigil at outermost positions.
 */
export class TurnBoundaryComponent extends Container {
	constructor(message: TurnStartMessage | TurnEndMessage) {
		super();

		const text =
			message.role === "turnStart" ? renderTurnStart(message) : renderTurnEnd(message);

		// Dim styling for boundaries — structural, not content
		this.addChild(
			new Text(theme.fg("dim", `─── ${text} ───`)),
		);
	}
}
