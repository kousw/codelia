import { $ } from "bun";

await $`bun run build:runtime`;
await $`bun run build:mainview`;
