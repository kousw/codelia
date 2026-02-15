import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import type { AgentsResolver } from "../agents";
import type { SandboxContext } from "../sandbox/context";
import type { SkillsResolver } from "../skills";
import { createAgentsResolveTool } from "./agents-resolve";
import { createBashTool } from "./bash";
import { createDoneTool } from "./done";
import { createEditTool } from "./edit";
import { createGlobSearchTool } from "./glob-search";
import { createGrepTool } from "./grep";
import {
	createLaneCloseTool,
	createLaneCreateTool,
	createLaneGcTool,
	createLaneListTool,
	createLaneStatusTool,
} from "./lane";
import { createReadTool } from "./read";
import { createSkillLoadTool } from "./skill-load";
import { createSkillSearchTool } from "./skill-search";
import { createTodoReadTool } from "./todo-read";
import { createTodoWriteTool } from "./todo-write";
import {
	createToolOutputCacheGrepTool,
	createToolOutputCacheTool,
} from "./tool-output-cache";
import { createWriteTool } from "./write";

export const createTools = (
	sandboxKey: DependencyKey<SandboxContext>,
	agentsResolverKey: DependencyKey<AgentsResolver>,
	skillsResolverKey: DependencyKey<SkillsResolver>,
	options: { toolOutputCacheStore?: ToolOutputCacheStore | null } = {},
): Tool[] => [
	createBashTool(sandboxKey),
	createReadTool(sandboxKey),
	createWriteTool(sandboxKey),
	createEditTool(sandboxKey),
	createAgentsResolveTool(sandboxKey, agentsResolverKey),
	createSkillSearchTool(skillsResolverKey),
	createSkillLoadTool(skillsResolverKey),
	createGlobSearchTool(sandboxKey),
	createGrepTool(sandboxKey),
	...(options.toolOutputCacheStore
		? [
				createToolOutputCacheTool(options.toolOutputCacheStore),
				createToolOutputCacheGrepTool(options.toolOutputCacheStore),
			]
		: []),
	createTodoReadTool(sandboxKey),
	createTodoWriteTool(sandboxKey),
	createLaneCreateTool(sandboxKey),
	createLaneListTool(sandboxKey),
	createLaneStatusTool(sandboxKey),
	createLaneCloseTool(sandboxKey),
	createLaneGcTool(sandboxKey),
	createDoneTool(),
];
