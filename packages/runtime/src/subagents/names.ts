import { z } from "zod";

export const subagentNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(48)
	// Provider JSON Schema validators may reject Unicode property escapes.
	.refine(
		(name) => /^[\p{L}][\p{L}\p{M}\p{N} .'-]*$/u.test(name),
		"Use an agent name",
	)
	.refine((name) => name.toLowerCase() !== "parent", "parent is reserved");
