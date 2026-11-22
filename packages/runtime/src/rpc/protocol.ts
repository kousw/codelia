// Catalog-backed validation and typed message builders for the runtime side
// of the UI protocol. See dev-docs/specs/protocol-codegen.md section 8.
import {
	type MethodsFrom,
	type ParamsOf,
	protocolMethods,
	RPC_ERROR_CODE,
	type ResultOf,
	type RpcError,
	type RpcNotification,
	type RpcRequest,
} from "@codelia/protocol";
import type { z } from "zod";
import { sendResult } from "./transport";

/** Requests the UI sends to the runtime. */
export type UiRequestMethod = MethodsFrom<"ui", "request">;
/** Requests the runtime sends to the UI. */
export type RuntimeRequestMethod = MethodsFrom<"runtime", "request">;
/** Notifications the UI sends to the runtime. */
export type UiNotificationMethod = MethodsFrom<"ui", "notification">;
/** Notifications the runtime sends to the UI. */
export type RuntimeNotificationMethod = MethodsFrom<"runtime", "notification">;

export type ProtocolIssue = { path: string; code: string; message: string };

const MAX_ISSUES = 10;

/** Zod issue messages name expected kinds, never the received value. */
const describeIssues = (error: z.ZodError): ProtocolIssue[] =>
	error.issues.slice(0, MAX_ISSUES).map((issue) => ({
		path: issue.path.map(String).join("."),
		code: issue.code,
		message: issue.message,
	}));

const schemaFor = (
	method: keyof typeof protocolMethods,
	slot: "params" | "result",
): z.ZodType => {
	const spec = protocolMethods[method];
	if (slot === "params") return spec.params;
	if (!("result" in spec))
		throw new Error(`${method} is a notification without a result`);
	return spec.result;
};

/**
 * Outgoing payloads are sent unchanged. They are checked against the catalog
 * only when CODELIA_PROTOCOL_ASSERT=1 (tests), so production never gains a new
 * failure mode.
 */
const assertOutgoing = (
	method: keyof typeof protocolMethods,
	slot: "params" | "result",
	value: unknown,
): void => {
	if (process.env.CODELIA_PROTOCOL_ASSERT !== "1") return;
	const result = schemaFor(method, slot).safeParse(value);
	if (!result.success)
		throw new Error(
			`protocol assertion failed for ${method} ${slot}: ${JSON.stringify(describeIssues(result.error))}`,
		);
};

/**
 * Validates request params after the method's existing gates. A failure is
 * answered with INVALID_PARAMS and bounded issue details. JSON-RPC allows
 * omitted params; they are read as `{}`.
 */
export const parseRequestParams = <M extends UiRequestMethod>(
	method: M,
	raw: unknown,
): { ok: true; params: ParamsOf<M> } | { ok: false; error: RpcError } => {
	const result = schemaFor(method, "params").safeParse(raw ?? {});
	if (result.success) return { ok: true, params: result.data as ParamsOf<M> };
	const issues = describeIssues(result.error);
	const first = issues[0];
	return {
		ok: false,
		error: {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			// The first issue names the field; issue messages never echo values.
			message: first
				? `invalid ${method} params: ${first.path || "params"}: ${first.message}`
				: `invalid ${method} params`,
			data: { issues },
		},
	};
};

/**
 * Validates the params of a UI -> runtime notification. A notification has no
 * reply, so a mismatch returns null and the caller drops it.
 */
export const parseUiNotificationParams = <M extends UiNotificationMethod>(
	method: M,
	raw: unknown,
): ParamsOf<M> | null => {
	const result = schemaFor(method, "params").safeParse(raw ?? {});
	return result.success ? (result.data as ParamsOf<M>) : null;
};

/** Sends the catalogued result of a UI -> runtime request. */
export const sendRequestResult = <M extends UiRequestMethod>(
	method: M,
	id: string,
	result: ResultOf<M>,
): void => {
	assertOutgoing(method, "result", result);
	sendResult(id, result);
};

/** Builds a runtime -> UI notification. */
export const notificationMessage = <M extends RuntimeNotificationMethod>(
	method: M,
	params: ParamsOf<M>,
): RpcNotification => {
	assertOutgoing(method, "params", params);
	return { jsonrpc: "2.0", method, params };
};

/** Builds a runtime -> UI request. */
export const requestMessage = <M extends RuntimeRequestMethod>(
	method: M,
	id: string,
	params: ParamsOf<M>,
): RpcRequest => {
	assertOutgoing(method, "params", params);
	return { jsonrpc: "2.0", id, method, params };
};

/** Validates the UI's result for a runtime -> UI request. */
export const parseUiResult = <M extends RuntimeRequestMethod>(
	method: M,
	raw: unknown,
):
	| { ok: true; result: ResultOf<M> }
	| { ok: false; issues: ProtocolIssue[] } => {
	const result = schemaFor(method, "result").safeParse(raw);
	if (result.success) return { ok: true, result: result.data as ResultOf<M> };
	return { ok: false, issues: describeIssues(result.error) };
};
