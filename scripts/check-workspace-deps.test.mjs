import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
	new URL("./check-workspace-deps.mjs", import.meta.url),
);

const makeFixture = () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "codelia-deps-check-"));
	const write = (file, content) => {
		const target = path.join(root, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(
			target,
			typeof content === "string" ? content : JSON.stringify(content),
		);
	};
	write("package.json", {
		workspaces: [
			"packages/*",
			"packages/core",
			"examples/basic-web",
			"tools/*",
		],
	});
	write("packages/core/package.json", {
		name: "@codelia/core",
		exports: { ".": "./index.js", "./sdk": "./sdk.js" },
	});
	write("examples/basic-web/package.json", { name: "@codelia/basic-web" });
	write("tools/viewer/package.json", { name: "@codelia/viewer" });
	return {
		write,
		run: () =>
			spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
};

test("checks undeclared workspace imports in example TSX files", () => {
	const fixture = makeFixture();
	try {
		fixture.write(
			"examples/basic-web/src/App.tsx",
			'import { Agent } from "@codelia/core";',
		);
		const result = fixture.run();
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/missing workspace deps in package\.json: @codelia\/core/,
		);
	} finally {
		fixture.cleanup();
	}
});

test("checks JS in tool workspaces and allows explicitly exported subpaths", () => {
	const fixture = makeFixture();
	try {
		fixture.write("examples/basic-web/package.json", {
			name: "@codelia/basic-web",
			dependencies: { "@codelia/core": "workspace:*" },
		});
		fixture.write(
			"examples/basic-web/src/App.tsx",
			'import "@codelia/core/sdk";',
		);
		fixture.write("tools/viewer/package.json", {
			name: "@codelia/viewer",
			dependencies: { "@codelia/core": "workspace:*" },
		});
		fixture.write(
			"tools/viewer/src/main.js",
			'import "@codelia/core/src/private";',
		);
		const invalid = fixture.run();
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /@codelia\/core\/src\/private/);
		fixture.write("tools/viewer/src/main.js", 'import "@codelia/core/sdk";');
		const valid = fixture.run();
		assert.equal(valid.status, 0, valid.stderr);
	} finally {
		fixture.cleanup();
	}
});
