import { describe, expect, it } from "bun:test";
import { viewerApiSchema } from "./api-schema";

describe("viewerApiSchema", () => {
	it("documents the discovery endpoint and task aggregate parameters", () => {
		expect(viewerApiSchema.entrypoint).toBe("/api/schema");
		expect(
			viewerApiSchema.endpoints.some(
				(endpoint) => endpoint.path === "/api/tasks",
			),
		).toBe(true);
		expect(
			viewerApiSchema.endpoints.some(
				(endpoint) => endpoint.path === "/api/schema",
			),
		).toBe(true);
		expect(viewerApiSchema.types.TaskAggregateSummary.windowSuccessDelta).toBe(
			"number | null",
		);
	});
});
