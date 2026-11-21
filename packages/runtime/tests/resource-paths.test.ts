import { expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resourceContainsPath } from "../src/permissions/resource-paths";
import { SandboxContext } from "../src/sandbox/context";

test("file selection reserves missing protected names and permits ordinary names", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-resource-names-")),
	);
	try {
		const reserved = path.join(root, "reserved-notes");
		const sandbox = await SandboxContext.create(root, {
			sandboxMode: "workspace-write",
			protectResources: true,
			extraProtectedPaths: [reserved],
		});
		expect(() =>
			sandbox.selectFile("reserved-notes/index.txt", "write"),
		).toThrow("Path is protected");
		expect(() => sandbox.selectFile("reserved-notes", "read")).toThrow(
			"Path is protected",
		);
		expect(
			sandbox.selectFile("regular-notes/index.txt", "write").identity,
		).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resource matching follows observed filesystem lookup for ordinary names", () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-directory-names-")),
	);
	try {
		const notes = path.join(root, "Notes");
		const alternate = path.join(root, "notes");
		mkdirSync(notes);
		writeFileSync(path.join(notes, "index.txt"), "fixture");
		const observed = lstatSync(alternate, { throwIfNoEntry: false });
		expect(resourceContainsPath(notes, path.join(alternate, "index.txt"))).toBe(
			observed?.ino === lstatSync(notes).ino,
		);
		expect(
			resourceContainsPath(
				path.join(root, "Future"),
				path.join(root, "future", "index.txt"),
			),
		).toBe(Boolean(observed));
		expect(resourceContainsPath(notes, path.join(root, "Notebook"))).toBe(
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
