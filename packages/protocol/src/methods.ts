import type { CatalogMethod } from "./catalog";

/**
 * Methods not yet in the catalog. A method moves from here to
 * `protocolMethods` in the change that catalogues it.
 */
export type LegacyMethod =
	| "goal.updated"
	| "goal.cleared"
	| "goal.ready"
	| "run.context"
	| "run.diagnostics"
	| "auth.login.status"
	| "tool.call"
	| "shell.exec"
	| "shell.start"
	| "shell.list"
	| "shell.status"
	| "shell.output"
	| "shell.wait"
	| "shell.detach"
	| "shell.cancel"
	| "task.spawn"
	| "task.list"
	| "task.status"
	| "task.wait"
	| "task.cancel"
	| "task.result"
	| "task.progress"
	| "mcp.list"
	| "skills.list"
	| "context.inspect"
	| "context.usage"
	| "run.context.usage"
	| "ui.context.update"
	| "ui.confirm.request"
	| "ui.prompt.request"
	| "ui.pick.request"
	| "ui.pick.cancelled";

export type ProtocolMethod = CatalogMethod | LegacyMethod;

type Assert<T extends true> = T;
/** Fails to compile when a method is listed in both places. */
export type _NoDuplicateProtocolMethod = Assert<
	[Extract<LegacyMethod, CatalogMethod>] extends [never] ? true : false
>;
