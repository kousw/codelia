// Sample helpers. Each sample is validated with its Zod schema at generation
// time and replayed by the Rust contract tests.
//
// - `expect` is the Rust receiver outcome: `typed` decodes to a known
//   variant, `unknown` decodes through an `Unknown` fallback, `error` fails.
// - `ts` is the TypeScript validation outcome (`skip` for methods outside the
//   catalog). TS validation is closed, so new values are `invalid` there.
// - `lossy` marks samples whose Rust re-serialization intentionally differs
//   (unknown fields dropped, collapse null written as absent).

export type FixtureRoute =
	| "ui_to_runtime_request"
	| "runtime_to_ui_response"
	| "runtime_to_ui_notification"
	| "ui_to_runtime_notification"
	| "runtime_to_ui_request"
	| "ui_to_runtime_response";

export type Sample = {
	case: string;
	route: FixtureRoute;
	method: string;
	message: Record<string, unknown>;
	expect: "typed" | "unknown" | "error";
	ts: "valid" | "invalid" | "skip";
	lossy?: true;
};

export const request = (method: string, params: unknown) => ({
	jsonrpc: "2.0",
	id: "1",
	method,
	params,
});
export const notification = (method: string, params: unknown) => ({
	jsonrpc: "2.0",
	method,
	params,
});
export const response = (result: unknown) => ({
	jsonrpc: "2.0",
	id: "1",
	result,
});

export type Shape = Omit<Sample, "route" | "method" | "message"> & {
	value: unknown;
};

export const group = (
	route: FixtureRoute,
	method: string,
	samples: Shape[],
): Sample[] =>
	samples.map(({ value, ...rest }) => ({
		...rest,
		route,
		method,
		message:
			route === "runtime_to_ui_response" || route === "ui_to_runtime_response"
				? response(value)
				: route.endsWith("_notification")
					? notification(method, value)
					: request(method, value),
	}));

export const typed = (caseName: string, value: unknown): Shape => ({
	case: caseName,
	value,
	expect: "typed",
	ts: "valid",
});
export const invalid = (
	caseName: string,
	value: unknown,
	expect: Sample["expect"] = "error",
): Shape => ({ case: caseName, value, expect, ts: "invalid" });

export const event = (value: Record<string, unknown>, extra = {}) => ({
	run_id: "run-1",
	seq: 3,
	event: value,
	...extra,
});
