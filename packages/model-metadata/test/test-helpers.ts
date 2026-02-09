import { test } from "bun:test";

export const integrationTest = process.env.INTEGRATION ? test : test.skip;
