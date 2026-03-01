export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	createSquiggleTools,
	type EndSquiggleDetails,
	endSquiggleTool,
	type StartSquiggleDetails,
	squiggleTools,
	startSquiggleTool,
} from "./squiggle.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";

import type { AgentTool } from "@punkin-pi/agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

// ============================================================================
// Tool Sets by Capability
// ============================================================================

/** Tools for reading/exploring (no side effects) */
export const readToolset: Tool[] = [readTool, grepTool, findTool, lsTool];

/** Tools for writing/modifying files */
export const writeToolset: Tool[] = [editTool, writeTool];

/** Tools for executing commands */
export const executeToolset: Tool[] = [bashTool];

// ============================================================================
// Tool Modes (composed from toolsets)
// ============================================================================

/** Read-only mode: exploration without modification */
export const readOnlyTools: Tool[] = [...readToolset];

/** Coding mode: read + write + execute (strict superset of readOnly) */
export const codingTools: Tool[] = [...readToolset, ...writeToolset, ...executeToolset];

// ============================================================================
// Tool Registry
// ============================================================================

/** All available tools by name */
export const allTools = {
	// Read toolset
	read: readTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	// Write toolset
	edit: editTool,
	write: writeTool,
	// Execute toolset
	bash: bashTool,
};

export type ToolName = keyof typeof allTools;

/** Default tool names (all coding tools) */
export const defaultToolNames: ToolName[] = Object.keys(allTools) as ToolName[];

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
}

// ============================================================================
// Tool Factories (for custom cwd)
// ============================================================================

/** Create read toolset for a specific working directory */
export function createReadToolset(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

/** Create write toolset for a specific working directory */
export function createWriteToolset(cwd: string): Tool[] {
	return [createEditTool(cwd), createWriteTool(cwd)];
}

/** Create execute toolset for a specific working directory */
export function createExecuteToolset(cwd: string, options?: ToolsOptions): Tool[] {
	return [createBashTool(cwd, options?.bash)];
}

/** Create read-only tools for a specific working directory */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return createReadToolset(cwd, options);
}

/** Create coding tools for a specific working directory (strict superset of readOnly) */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [...createReadToolset(cwd, options), ...createWriteToolset(cwd), ...createExecuteToolset(cwd, options)];
}

/** Create all tools for a specific working directory */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		// Read toolset
		read: createReadTool(cwd, options?.read),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		// Write toolset
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		// Execute toolset
		bash: createBashTool(cwd, options?.bash),
	};
}
