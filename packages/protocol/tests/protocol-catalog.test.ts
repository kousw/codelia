import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CatalogMethod,
	type ClientToolCancelParams,
	isCatalogMethod,
	type ParamsOf,
	type ProtocolMethod,
	protocolMethods,
	type ResultOf,
	type ThemeSetParams,
	type ThemeSetResult,
} from "../src";

type Exact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type Assert<T extends true> = T;

// Catalog-derived types are the public types.
export type _ThemeParams = Assert<Exact<ParamsOf<"theme.set">, ThemeSetParams>>;
export type _ThemeResult = Assert<Exact<ResultOf<"theme.set">, ThemeSetResult>>;
export type _Cancel = Assert<
	Exact<ParamsOf<"client.tool.cancel">, ClientToolCancelParams>
>;
export type _Listed = Assert<
	"client.tool.cancel" extends ProtocolMethod ? true : false
>;

type Fixture = {
	case: string;
	route: string;
	method: string;
	message: { params?: unknown; result?: unknown };
	expect: "typed" | "unknown" | "error";
	ts: "valid" | "invalid" | "skip";
};

const FIXTURE_DIR = join(import.meta.dir, "fixtures/protocol");
const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
	.filter((name) => name.endsWith(".jsonl"))
	.flatMap((name) =>
		readFileSync(join(FIXTURE_DIR, name), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Fixture),
	);

const schemaFor = (fixture: Fixture) => {
	const spec = protocolMethods[fixture.method as CatalogMethod];
	const isResponse = fixture.route.endsWith("_response");
	if (!isResponse) return spec.params;
	if (!("result" in spec)) throw new Error(`${fixture.method} has no result`);
	return spec.result;
};

describe("protocol catalog", () => {
	test("every catalogued schema is named for the generator", () => {
		for (const [method, spec] of Object.entries(protocolMethods)) {
			expect(spec.params.meta()?.id, `${method} params`).toBeString();
			if ("result" in spec)
				expect(spec.result.meta()?.id, `${method} result`).toBeString();
		}
	});

	test("shared fixtures validate as declared in TypeScript", () => {
		expect(fixtures.length).toBeGreaterThan(50);
		for (const fixture of fixtures) {
			const label = `${fixture.route} ${fixture.method}: ${fixture.case}`;
			if (fixture.ts === "skip") {
				expect(isCatalogMethod(fixture.method), label).toBe(false);
				continue;
			}
			const payload =
				"result" in fixture.message
					? fixture.message.result
					: fixture.message.params;
			expect(schemaFor(fixture).safeParse(payload).success, label).toBe(
				fixture.ts === "valid",
			);
		}
	});

	test("strict decoding rejects new values; receivers strip unknown keys", () => {
		const status = protocolMethods["run.status"].params;
		expect(status.safeParse({ run_id: "r", status: "suspended" }).success).toBe(
			false,
		);
		const parsed = status.parse({
			run_id: "r",
			status: "running",
			future_field: true,
		});
		expect(parsed).toEqual({ run_id: "r", status: "running" });
	});
});
