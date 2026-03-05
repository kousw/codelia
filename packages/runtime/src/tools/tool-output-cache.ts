import type { Tool, ToolOutputCacheStore } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";

export const createToolOutputCacheTool = (store: ToolOutputCacheStore): Tool =>
	defineTool({
		name: "tool_output_cache",
		description: "Read cached tool output by ref_id.",
		input: z.object({
			ref_id: z.string().describe("Tool output reference ID."),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Optional 0-based line offset."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Optional max number of lines to return."),
			allow_truncate: z
				.boolean()
				.optional()
				.describe("Allow truncation when output is too large. Default false."),
		}),
		execute: async (input) => {
			if (!store.read) {
				return "tool_output_cache is unavailable.";
			}
			try {
				return await store.read(input.ref_id, {
					offset: input.offset,
					limit: input.limit,
					allow_truncate: input.allow_truncate,
				});
			} catch (error) {
				return `Error reading tool output cache: ${String(error)}`;
			}
		},
	});

export const createToolOutputCacheLineTool = (
	store: ToolOutputCacheStore,
): Tool =>
	defineTool({
		name: "tool_output_cache_line",
		description:
			"Read a single cached output line segment by line number and char offset.",
		input: z.object({
			ref_id: z.string().describe("Tool output reference ID."),
			line_number: z
				.number()
				.int()
				.positive()
				.describe("1-based line number to read."),
			char_offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("0-based start character in the target line. Default 0."),
			char_limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Max chars to return."),
		}),
		execute: async (input) => {
			if (!store.readLine) {
				return "tool_output_cache_line is unavailable.";
			}
			try {
				return await store.readLine(input.ref_id, {
					line_number: input.line_number,
					char_offset: input.char_offset,
					char_limit: input.char_limit,
				});
			} catch (error) {
				return `Error reading cache line: ${String(error)}`;
			}
		},
	});

export const createToolOutputCacheGrepTool = (
	store: ToolOutputCacheStore,
): Tool =>
	defineTool({
		name: "tool_output_cache_grep",
		description: "Search cached tool output by ref_id.",
		input: z.object({
			ref_id: z.string().describe("Tool output reference ID."),
			pattern: z.string().describe("Text or regex pattern to search for."),
			regex: z
				.boolean()
				.optional()
				.describe("Interpret pattern as regex when true. Default false."),
			before: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Context lines before each match. Default 0."),
			after: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Context lines after each match. Default 0."),
			max_matches: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Maximum number of matches to return."),
		}),
		execute: async (input) => {
			if (!store.grep) {
				return "tool_output_cache_grep is unavailable.";
			}
			try {
				return await store.grep(input.ref_id, {
					pattern: input.pattern,
					regex: input.regex,
					before: input.before,
					after: input.after,
					max_matches: input.max_matches,
				});
			} catch (error) {
				return `Error searching tool output cache: ${String(error)}`;
			}
		},
	});
