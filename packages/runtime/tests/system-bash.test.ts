import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { platformShellSource } from "../src/permissions/shell-backend";
import { resolveSystemBash } from "../src/permissions/system-bash";

type FixtureEntry = {
	kind: "directory" | "file" | "symlink";
	uid?: number;
	mode?: number;
	destination?: string;
};

const bashStore = "/nix/store/fixture-bash/bin/bash";
const nixFixture = {
	"/": { kind: "directory" },
	"/run": { kind: "directory" },
	"/run/current-system": { kind: "symlink", destination: "/nix/store/system" },
	"/nix": { kind: "directory" },
	"/nix/store": { kind: "directory", mode: 0o1775 },
	"/nix/store/system": { kind: "directory" },
	"/nix/store/system/sw": { kind: "symlink", destination: "../system-path" },
	"/nix/store/system-path": { kind: "directory" },
	"/nix/store/system-path/bin": { kind: "directory" },
	"/nix/store/system-path/bin/bash": {
		kind: "symlink",
		destination: bashStore,
	},
	"/nix/store/fixture-bash": { kind: "directory" },
	"/nix/store/fixture-bash/bin": { kind: "directory" },
	[bashStore]: { kind: "file" },
} satisfies Record<string, FixtureEntry>;

const lookup = (contents: Readonly<Record<string, FixtureEntry>>) => ({
	stat: (name: string) => {
		const entry = contents[name];
		return (
			entry && {
				uid: entry.uid ?? 0,
				mode: entry.mode ?? 0o755,
				isDirectory: () => entry.kind === "directory",
				isFile: () => entry.kind === "file",
				isSymbolicLink: () => entry.kind === "symlink",
			}
		);
	},
	readLink: (name: string) => contents[name].destination ?? "",
	canExecute: () => {},
});

test("Linux accepts the canonical Bash of a trusted NixOS system profile", () => {
	expect(resolveSystemBash("linux", lookup(nixFixture))).toBe(bashStore);
	expect(
		resolveSystemBash(
			"linux",
			lookup({
				"/": { kind: "directory" },
				"/bin": { kind: "symlink", destination: "usr/bin" },
				"/usr": { kind: "directory" },
				"/usr/bin": { kind: "directory" },
				"/usr/bin/bash": { kind: "file" },
			}),
		),
	).toBe("/usr/bin/bash");
});

test("an untrusted link or writable Nix output cannot select Bash", () => {
	for (const replacements of [
		{
			"/run/current-system": { ...nixFixture["/run/current-system"], uid: 501 },
		},
		{ "/nix/store": { kind: "directory", mode: 0o0775 } },
		{ "/nix/store/fixture-bash": { kind: "directory", mode: 0o0775 } },
		{ [bashStore]: { kind: "file", mode: 0o0775 } },
	] satisfies Record<string, FixtureEntry>[]) {
		expect(
			resolveSystemBash("linux", lookup({ ...nixFixture, ...replacements })),
		).toBeUndefined();
	}
});

test.skipIf(!resolveSystemBash())(
	"the standard source launcher runs trusted Bash with no command PATH",
	() => {
		const executable = resolveSystemBash();
		const invocation = platformShellSource("printf '%s' fixture");
		if (!executable || invocation.kind !== "source")
			throw new Error("Expected a trusted Bash source invocation");
		expect(invocation.executable).toBe(executable);
		const result = spawnSync(
			invocation.executable,
			[...invocation.options, invocation.source],
			{ env: { PATH: "" }, encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("fixture");
	},
);
