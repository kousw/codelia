import path from "node:path";

/** Checks lexical containment, including equality, without resolving symlinks. */
export const isWithin = (root: string, target: string): boolean => {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
};
