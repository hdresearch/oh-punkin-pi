import type { AssistantMessage } from "@punkin-pi/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@punkin-pi/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { ThinkingBlock } from "./thinking-block.js";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;
	private thinkingBlocks: ThinkingBlock[] = [];

	constructor(
		message?: AssistantMessage,
		_hideThinkingBlock = false, // deprecated, ignored — thinking is never hidden
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();

		this.markdownTheme = markdownTheme;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** @deprecated Thinking is never hidden. This is a no-op for backward compatibility. */
	setHideThinkingBlock(_hide: boolean): void {
		// no-op — thinking is never hidden
	}

	/** Get all thinking blocks for toggle interactions */
	getThinkingBlocks(): ThinkingBlock[] {
		return this.thinkingBlocks;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.thinkingBlocks = [];

		// Clear content container
		this.contentContainer.clear();

		// Squiggle-wins policy: if any text block already contains <squiggle> markup,
		// skip rendering thinking blocks to avoid duplicate CoT display.
		// Provider thinking blocks and user-authored squiggle carry the same information.
		const textHasSquiggle = message.content.some(
			(c) => c.type === "text" && c.text.includes("<squiggle>"),
		);

		const hasVisibleContent = message.content.some(
			(c) =>
				(c.type === "text" && c.text.trim()) ||
				(!textHasSquiggle && c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (!textHasSquiggle && content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(c) =>
							(c.type === "text" && c.text.trim()) ||
							(!textHasSquiggle && c.type === "thinking" && c.thinking.trim()),
					);

				// Collapsible thinking block — never hidden, expanded by default
				const THINKING_EXPANDED_BY_DEFAULT = true;
				const thinkingBlock = new ThinkingBlock(content.thinking.trim(), THINKING_EXPANDED_BY_DEFAULT, this.markdownTheme);
				this.thinkingBlocks.push(thinkingBlock);
				this.contentContainer.addChild(thinkingBlock);

				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}
