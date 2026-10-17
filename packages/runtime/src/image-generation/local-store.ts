import { createHash } from "node:crypto";
import path from "node:path";
import { ImageArtifactStore, resolveStoragePaths } from "@codelia/storage";

export function createLocalImageStore(
	workspaceRoot: string,
): ImageArtifactStore {
	const scope = createHash("sha256")
		.update(path.resolve(workspaceRoot))
		.digest("hex");
	return new ImageArtifactStore(
		path.join(resolveStoragePaths().sessionsDir, "image-artifacts", scope),
	);
}
