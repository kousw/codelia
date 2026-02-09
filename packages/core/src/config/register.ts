import { configRegistry } from "@codelia/config";
import {
	OPENAI_DEFAULT_MODEL,
	OPENAI_DEFAULT_REASONING_EFFORT,
} from "../models/openai";

configRegistry.registerDefaults({
	model: {
		provider: "openai",
		name: OPENAI_DEFAULT_MODEL,
		reasoning: OPENAI_DEFAULT_REASONING_EFFORT,
	},
});
