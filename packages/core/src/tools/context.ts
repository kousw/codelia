import type { Logger } from "openai/client";

export type DependencyKey<T> = {
	id: string;
	create: () => T | Promise<T>;
};

export type DependencyOverrides = Map<string, () => unknown | Promise<unknown>>;

export type ToolContext = {
	signal?: AbortSignal;
	logger?: Logger;
	now?: () => Date;

	// DI
	deps: Record<string, unknown>;
	resolve: <T>(key: DependencyKey<T>) => Promise<T>;
};
