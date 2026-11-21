import path from "node:path";
import type { ShellInvocation } from "../permissions/shell-analysis";
import type { FileSelection, MissingFileSelection } from "./context";

export type FixedFileMutationPaths = Readonly<{
	directories: readonly string[];
	destination?: string;
	source?: string;
}>;

export type DirectoryMutation =
	| Readonly<{
			kind: "create";
			destination: MissingFileSelection;
			content: string | Uint8Array;
			mode?: number;
	  }>
	| Readonly<{ kind: "delete"; source: FileSelection }>
	| Readonly<{
			kind: "move";
			source: FileSelection;
			destination: MissingFileSelection;
			content: string | Uint8Array;
			mode?: number;
	  }>;

// All operands are passed as argv. File contents come from the private pipe.
const script = `
const fs = require("node:fs");
const path = require("node:path");
const [kind, source, target, identity, mode, parent, parentIdentity, tail] = process.argv.slice(1);
const c = fs.constants;
function checkSource() {
  const file = fs.lstatSync(source, { bigint: true });
  const actual = [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(":");
  if (!file.isFile() || actual !== identity) throw new Error("source_changed_after_approval");
}
function checkParent() {
  const stat = fs.lstatSync(parent, { bigint: true });
  if (!stat.isDirectory() || fs.realpathSync(parent) !== parent ||
      [stat.dev, stat.ino, stat.birthtimeNs].join(":") !== parentIdentity)
    throw new Error("destination_parent_changed_after_approval");
}
function create(content) {
  const segments = tail.split(path.sep);
  if (path.join(parent, tail) !== target ||
      segments.some((part) => !part || part === "." || part === ".."))
    throw new Error("invalid_destination_binding");
  checkParent();
  let directory = parent;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    try {
      if (!fs.lstatSync(directory).isDirectory())
        throw new Error("destination_path_changed_after_approval");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(directory);
    }
  }
  checkParent();
  if (fs.realpathSync(directory) !== directory)
    throw new Error("destination_path_changed_after_approval");
  const fd = fs.openSync(target, c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW, Number(mode));
  try {
    fs.writeFileSync(fd, content);
    if (mode !== "438") fs.fchmodSync(fd, Number(mode));
  } finally {
    fs.closeSync(fd);
  }
}
try {
  const content = kind === "delete" ? undefined : fs.readFileSync(0);
  if (kind !== "create") checkSource();
  if (kind !== "delete") create(content);
  if (kind !== "create") {
    try {
      checkSource();
      fs.unlinkSync(source);
    } catch (error) {
      if (kind === "move")
        throw new Error("move_destination_created_source_not_removed: " + (error.code ?? error.message));
      throw error;
    }
  }
} catch (error) {
  process.stderr.write(String(error.code ?? error.message));
  process.exitCode = 1;
}
`;

const fixedMutationPaths = (
	source: FileSelection | undefined,
	destination: MissingFileSelection | undefined,
): FixedFileMutationPaths => {
	const directories: string[] = [];
	if (destination) {
		let current = destination.parent;
		for (const segment of destination.tail.split(path.sep).slice(0, -1)) {
			current = path.join(current, segment);
			directories.push(current);
		}
	}
	return {
		directories,
		source: source?.target,
		destination: destination?.target,
	};
};

export const fixedFileMutation = (mutation: DirectoryMutation) => {
	const source = mutation.kind === "create" ? undefined : mutation.source;
	const destination =
		mutation.kind === "delete" ? undefined : mutation.destination;
	const invocation: Extract<ShellInvocation, { kind: "argv" }> = Object.freeze({
		kind: "argv",
		executable: process.execPath,
		args: Object.freeze([
			"-e",
			script,
			"--",
			mutation.kind,
			source?.target ?? "",
			destination?.target ?? "",
			source?.identity ?? "",
			String((mutation.kind === "delete" ? undefined : mutation.mode) ?? 0o666),
			destination?.parent ?? "",
			destination?.parentIdentity ?? "",
			destination?.tail ?? "",
		]),
	});
	return { invocation, paths: fixedMutationPaths(source, destination) };
};
