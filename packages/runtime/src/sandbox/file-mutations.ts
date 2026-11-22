import path from "node:path";
import { isHomeDotTarget } from "../permissions/home-dot-paths";
import { resourceContainsPath } from "../permissions/resource-paths";
import {
	isWithin,
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	type ShellProtection,
	supportsProtectedShell,
} from "../permissions/shell-backend";
import { terminateChild } from "../tasks/shell-executor";
import { missingDestinationCurrent } from "./context";
import {
	type DirectoryMutation,
	fixedFileMutation,
} from "./file-mutation-helper";

export type DirectoryMutationBroker = {
	supports: () => boolean;
	run: (mutation: DirectoryMutation, signal?: AbortSignal) => Promise<void>;
};

export const createDirectoryMutationBroker = ({
	backend,
	useFixedSeatbelt,
	resolveProtection,
}: {
	backend: ProtectedShellBackend;
	useFixedSeatbelt?: boolean;
	resolveProtection: () => ShellProtection;
}): DirectoryMutationBroker => {
	const fixedBackend =
		useFixedSeatbelt && backend instanceof MacSeatbeltBackend
			? backend
			: undefined;
	return {
		supports: () => {
			const protection = resolveProtection();
			return fixedBackend
				? fixedBackend.supportsFixedFileMutation(protection)
				: supportsProtectedShell(backend, protection);
		},
		async run(mutation, signal) {
			signal?.throwIfAborted();
			const protection = resolveProtection();
			const source = mutation.kind === "create" ? undefined : mutation.source;
			const destination =
				mutation.kind === "delete" ? undefined : mutation.destination;
			if (
				(source &&
					(source.access !== "write" ||
						!source.identity ||
						!isWithin(protection.root, source.target))) ||
				(destination &&
					(destination.access !== "write" ||
						!path.isAbsolute(destination.target) ||
						!isWithin(protection.root, destination.target) ||
						!isWithin(protection.root, destination.parent)))
			)
				throw new Error("directory_mutation_outside_workspace");
			if (
				[source, destination].some(
					(entry) =>
						entry &&
						protection.protectedPaths.some((root) =>
							resourceContainsPath(root, entry.target),
						),
				)
			)
				throw new Error("directory_mutation_protected_path");
			if (
				[source, destination].some(
					(entry) =>
						entry &&
						((protection.homeDotDirectory &&
							isHomeDotTarget(protection.homeDotDirectory, entry.target)) ||
							protection.readOnlyPaths?.some((root) =>
								resourceContainsPath(root, entry.target),
							)),
				)
			)
				throw new Error("directory_mutation_readonly_path");
			if (destination && !missingDestinationCurrent(destination))
				throw new Error("destination_changed_after_approval");
			let child: ReturnType<ProtectedShellBackend["launch"]>;
			if (fixedBackend) {
				child = fixedBackend.launchFixedFileMutation(protection, mutation);
			} else {
				const { invocation } = fixedFileMutation(mutation);
				if (!supportsProtectedShell(backend, protection, invocation))
					throw new Error("sandbox_directory_mutation_unavailable");
				child = backend.launch(invocation, protection);
			}
			await new Promise<void>((resolve, reject) => {
				let failure = "";
				const abort = () => terminateChild(child, "SIGKILL");
				const timer = setTimeout(abort, 10_000);
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				};
				child.stderr.on("data", (chunk: Buffer) => {
					if (failure.length < 200)
						failure += chunk.toString("utf8").slice(0, 200 - failure.length);
				});
				child.stdout.resume();
				child.once("error", (error) => {
					cleanup();
					reject(error);
				});
				child.once("close", (code) => {
					cleanup();
					if (code === 0) resolve();
					else reject(new Error(failure || "protected_file_mutation_failed"));
				});
				if (!child.stdin) {
					abort();
					return;
				}
				child.stdin.on("error", () => undefined);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				else
					child.stdin.end(mutation.kind === "delete" ? "" : mutation.content);
			});
		},
	};
};
