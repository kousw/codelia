import { describe, expect, test } from "bun:test";
import { canEvictRuntimeClient } from "../src/server/service";

describe("desktop runtime eviction", () => {
	test("evicts only inactive clients without pending requests", () => {
		expect(canEvictRuntimeClient({ pendingRequestCount: 0 }, false)).toBe(true);
		expect(canEvictRuntimeClient({ pendingRequestCount: 1 }, false)).toBe(false);
		expect(canEvictRuntimeClient({ pendingRequestCount: 0 }, true)).toBe(false);
		expect(canEvictRuntimeClient({ pendingRequestCount: 3 }, true)).toBe(false);
	});
});
