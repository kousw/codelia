import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import type { AgentsResolver } from "../agents";
import type { SandboxContext } from "../sandbox/context";
import type { SkillsResolver } from "../skills";
import type { TaskManager } from "../tasks";
import { createAgentsResolveTool } from "./agents-resolve";
import { createApplyPatchTool } from "./apply-patch";
import { createDoneTool } from "./done";
import { createEditTool } from "./edit";
import {
	createLaneCloseTool,
	createLaneCreateTool,
	createLaneGcTool,
	createLaneListTool,
	createLaneStatusTool,
} from "./lane";
import { createReadTool } from "./read";
import { createReadLineTool } from "./read-line";
import { createSearchTool, type SearchToolOptions } from "./search";
import type { ToolSessionContext } from "./session-context";
import {
	createShellCancelTool,
	createShellListTool,
	createShellLogsTool,
	createShellResultTool,
	createShellStatusTool,
	createShellTool,
	createShellWaitTool,
} from "./shell";
import { createSkillLoadTool } from "./skill-load";
import { createSkillSearchTool } from "./skill-search";
import {
	createTodoAppendTool,
	createTodoClearTool,
	createTodoNewTool,
	createTodoPatchTool,
} from "./todo-mutate";
import { createTodoReadTool } from "./todo-read";
import {
	createToolOutputCacheGrepTool,
	createToolOutputCacheLineTool,
	createToolOutputCacheTool,
} from "./tool-output-cache";
import { createWriteTool } from "./write";
import { createViewImageTool } from "./view-image";
import { createWebfetchTool } from "./webfetch";

export const createTools = (
	sandboxKey: DependencyKey<SandboxContext>,
	agentsResolverKey: DependencyKey<AgentsResolver>,
	skillsResolverKey: DependencyKey<SkillsResolver>,
	options: {
		toolOutputCacheStore?: ToolOutputCacheStore | null;
		search?: SearchToolOptions;
		todoSessionContextKey?: DependencyKey<ToolSessionContext>;
		taskManager?: TaskManager;
	} = {},
): Tool[] => [
	createShellTool(sandboxKey, {
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
		sessionContextKey: options.todoSessionContextKey,
	}),
	createShellListTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createShellStatusTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createShellLogsTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createShellWaitTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createShellResultTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createShellCancelTool({
		taskManager: options.taskManager,
		outputCacheStore: options.toolOutputCacheStore,
	}),
	createReadTool(sandboxKey),
	createReadLineTool(sandboxKey),
	createWriteTool(sandboxKey, options.toolOutputCacheStore),
	createEditTool(sandboxKey, options.toolOutputCacheStore),
	createApplyPatchTool(sandboxKey, options.toolOutputCacheStore),
	createViewImageTool(sandboxKey),
	createAgentsResolveTool(sandboxKey, agentsResolverKey),
	createSkillSearchTool(skillsResolverKey),
	createSkillLoadTool(skillsResolverKey),
	createWebfetchTool(),
	...(options.search ? [createSearchTool(options.search)] : []),
	...(options.toolOutputCacheStore
		? [
				createToolOutputCacheTool(options.toolOutputCacheStore),
				createToolOutputCacheLineTool(options.toolOutputCacheStore),
				createToolOutputCacheGrepTool(options.toolOutputCacheStore),
			]
		: []),
	createTodoReadTool(sandboxKey, options.todoSessionContextKey),
	createTodoNewTool(sandboxKey, options.todoSessionContextKey),
	createTodoAppendTool(sandboxKey, options.todoSessionContextKey),
	createTodoPatchTool(sandboxKey, options.todoSessionContextKey),
	createTodoClearTool(sandboxKey, options.todoSessionContextKey),
	createLaneCreateTool(sandboxKey),
	createLaneListTool(sandboxKey),
	createLaneStatusTool(sandboxKey),
	createLaneCloseTool(sandboxKey),
	createLaneGcTool(sandboxKey),
	createDoneTool(),
];
