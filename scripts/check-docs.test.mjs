import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));

const makeFixture = () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "codelia-docs-check-"));
	const write = (file, content) => {
		const target = path.join(root, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	};
	write("README.md", "# Repo\n\nSee [Guide](docs/guide.md).\n");
	write("AGENTS.md", "# Root\n\nSee `packages/core/src/index.ts`.\n");
	write("packages/core/src/index.ts", "export {};\n");
	write(
		"packages/core/AGENTS.md",
		"# Core\n\nEntry: `src/index.ts` or `packages/core/src/index.ts`.\n",
	);
	write("docs/guide.md", "# Guide\n");
	write(
		"dev-docs/environment-variables.md",
		[
			"# Env",
			"",
			"| `CODELIA_RUNTIME_CMD` / `_ARGS` | launcher | Doc | Active |",
			"",
			"Previously env-based handoffs now moved off the environment:",
			"- `CODELIA_CLI_VERSION`, bundled `CODELIA_RUNTIME_CMD` / `_ARGS` → `--internal-launch-context=<json>`.",
			"",
			"Removed in favor of config, CLI flags, standard npm vars, or constants:",
			"- `CODELIA_TUI_MODE` → removed (use `--tui-mode`).",
			"- Tuning knobs (`CODELIA_AGENTS_RESOLVER_ENABLED`, `_MARKERS`) → inlined as constants.",
			"",
			"Removed individual debug env vars folded into `CODELIA_DEBUG=<topics>`:",
			"`CODELIA_SESSION_DUMP`, `CODELIA_PROVIDER_LOG`.",
			"",
		].join("\n"),
	);
	write("dev-docs/archive/README.md", "# Archive\n\nSee [Old](old.md).\n");
	write("dev-docs/archive/old.md", "# Old\n\n[Broken](./missing.md)\n");
	return {
		write,
		run: () =>
			spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
};

test("passes on valid docs, AGENTS paths, archive exclusions, and active env vars", () => {
	const fixture = makeFixture();
	try {
		fixture.write(
			"docs/active.md",
			"Uses `CODELIA_RUNTIME_CMD` and `CODELIA_RUNTIME_ARGS`.\n",
		);
		const result = fixture.run();
		assert.equal(result.status, 0, result.stderr);
	} finally {
		fixture.cleanup();
	}
});

test("rejects any RULES.md file in the repository", () => {
	const fixture = makeFixture();
	try {
		fixture.write("packages/core/RULES.md", "# Stale rules\n");
		const result = fixture.run();
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/unexpected RULES\.md file: packages\/core\/RULES\.md/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("rejects broken relative links outside fences and outside archive body files", () => {
	const fixture = makeFixture();
	try {
		fixture.write(
			"docs/guide.md",
			[
				"# Guide",
				"```md",
				"[Example](does-not-exist.md)",
				"```",
				"Real [Broken](../missing.md)",
			].join("\n"),
		);
		const result = fixture.run();
		assert.equal(result.status, 1);
		assert.doesNotMatch(result.stderr, /does-not-exist\.md/);
		assert.match(result.stderr, /broken relative link in docs\/guide\.md:5/);

		fixture.write("docs/guide.md", "# Guide\n");
		fixture.write("dev-docs/archive/README.md", "# Archive\n[Bad](nope.md)\n");
		const archiveIndexResult = fixture.run();
		assert.equal(archiveIndexResult.status, 1);
		assert.match(
			archiveIndexResult.stderr,
			/broken relative link in dev-docs\/archive\/README\.md:2/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("rejects broken inline repo paths in AGENTS.md", () => {
	const fixture = makeFixture();
	try {
		fixture.write(
			"AGENTS.md",
			"# Root\n\nMissing `packages/core/src/nope.ts`.\n",
		);
		const result = fixture.run();
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/broken path reference in AGENTS\.md:3: `packages\/core\/src\/nope\.ts`/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("flags retired env vars while allowing explicit migration notes", () => {
	const fixture = makeFixture();
	try {
		fixture.write("docs/guide.md", "Legacy flag `CODELIA_AGENTS_MARKERS`.\n");
		const result = fixture.run();
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/retired env var in docs\/guide\.md:1: CODELIA_AGENTS_MARKERS/,
		);

		fixture.write(
			"docs/guide.md",
			"`CODELIA_TUI_MODE` is retired. <!-- check-docs:allow-retired-env -->\n",
		);
		const allowed = fixture.run();
		assert.equal(allowed.status, 0, allowed.stderr);
	} finally {
		fixture.cleanup();
	}
});
