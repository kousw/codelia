// Shared wire samples, one file per protocol area. See helpers.ts for the
// meaning of `expect`, `ts` and `lossy`.
import { coreSamples } from "./core";
import type { Sample } from "./helpers";
import { runSamples } from "./run";
import { sessionSamples } from "./session";
import { settingsSamples } from "./settings";
import { notificationSamples } from "./notifications";
import { taskSamples } from "./tasks";

export type { FixtureRoute, Sample } from "./helpers";

export const samples: Sample[] = [
	...coreSamples,
	...runSamples,
	...sessionSamples,
	...settingsSamples,
	...taskSamples,
	...notificationSamples,
];
