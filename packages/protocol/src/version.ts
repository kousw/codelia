import { z } from "zod";

export const ProtocolVersionSchema = z
	.literal("0")
	.meta({ id: "ProtocolVersion" });
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
