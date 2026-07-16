import { describe, expect, test } from "bun:test";
import {
	DEFAULT_VIEWER_HOSTNAME,
	resolveViewerHostname,
} from "./server-options";

describe("resolveViewerHostname", () => {
	test("binds to loopback by default", () => {
		expect(resolveViewerHostname(undefined)).toBe(DEFAULT_VIEWER_HOSTNAME);
	});

	test("accepts an explicit hostname for remote access", () => {
		expect(resolveViewerHostname("0.0.0.0")).toBe("0.0.0.0");
	});
});
