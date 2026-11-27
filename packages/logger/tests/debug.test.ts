import { afterEach, describe, expect, test } from "bun:test";
import {
	getDebugConfig,
	getDebugDir,
	hasDebugTopic,
	isDebugEnabled,
	parseDebugConfig,
} from "../src/index";

describe("@codelia/logger debug config", () => {
	const originalDebug = process.env.CODELIA_DEBUG;
	const originalDir = process.env.CODELIA_DEBUG_DIR;

	afterEach(() => {
		if (originalDebug === undefined) delete process.env.CODELIA_DEBUG;
		else process.env.CODELIA_DEBUG = originalDebug;
		if (originalDir === undefined) delete process.env.CODELIA_DEBUG_DIR;
		else process.env.CODELIA_DEBUG_DIR = originalDir;
	});

	test("defaults to all topics disabled when unset or falsey", () => {
		for (const raw of [undefined, "", "0", "false", "off", "no"]) {
			const cfg = parseDebugConfig(raw);
			expect(cfg.debug).toBe(false);
			expect(cfg.rpc).toBe(false);
			expect(cfg.ws).toBe(false);
			expect(cfg.perf).toBe(false);
			expect(cfg.keys).toBe(false);
			expect(cfg.diff).toBe(false);
			expect(cfg.diagnostics).toBe(false);
			expect(cfg.providerLog).toBe(false);
			expect(cfg.sessionDump).toBe(false);
			expect(cfg.ansiSyntax).toBe(false);
		}
	});

	test("1/true enables general debug without disk dumps or UI modes", () => {
		for (const raw of ["1", "true", "TRUE", "on"]) {
			const cfg = parseDebugConfig(raw);
			expect(cfg.debug).toBe(true);
			expect(cfg.rpc).toBe(true);
			expect(cfg.ws).toBe(true);
			expect(cfg.perf).toBe(false);
			expect(cfg.providerLog).toBe(false);
			expect(cfg.sessionDump).toBe(false);
			expect(cfg.diagnostics).toBe(false);
		}
	});

	test("parses comma-separated topics and CODELIA_DEBUG_DIR", () => {
		const cfg = parseDebugConfig(
			"perf, provider-log, session-dump, diff-highlight, keys, diagnostics, ansi-syntax",
			"  /tmp/codelia-debug  ",
		);
		expect(cfg.debug).toBe(false);
		expect(cfg.perf).toBe(true);
		expect(cfg.providerLog).toBe(true);
		expect(cfg.sessionDump).toBe(true);
		expect(cfg.diff).toBe(true);
		expect(cfg.keys).toBe(true);
		expect(cfg.diagnostics).toBe(true);
		expect(cfg.ansiSyntax).toBe(true);
		expect(cfg.dir).toBe("/tmp/codelia-debug");
	});

	test("all/* enables safe runtime/TUI topics without raw disk dumps", () => {
		const cfg = parseDebugConfig("all");
		expect(cfg.debug).toBe(true);
		expect(cfg.perf).toBe(true);
		expect(cfg.keys).toBe(true);
		expect(cfg.diff).toBe(true);
		expect(cfg.diagnostics).toBe(true);
		expect(cfg.providerLog).toBe(false);
		expect(cfg.sessionDump).toBe(false);
	});

	test("cached process.env reader tracks dynamic mutations", () => {
		delete process.env.CODELIA_DEBUG;
		delete process.env.CODELIA_DEBUG_DIR;
		expect(isDebugEnabled()).toBe(false);
		expect(hasDebugTopic("provider-log")).toBe(false);

		process.env.CODELIA_DEBUG = "provider-log,rpc";
		process.env.CODELIA_DEBUG_DIR = "/tmp/custom-debug";
		expect(isDebugEnabled()).toBe(true);
		expect(hasDebugTopic("rpc")).toBe(true);
		expect(hasDebugTopic("provider-log")).toBe(true);
		expect(hasDebugTopic("session-dump")).toBe(false);
		expect(getDebugDir()).toBe("/tmp/custom-debug");
		expect(getDebugConfig()).toBe(getDebugConfig());
	});
});
