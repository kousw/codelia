import { describe, expect, test } from "bun:test";
import { resolveBrowserLaunch } from "../src/auth/openai-oauth";

describe("openai oauth browser launch", () => {
	test("uses open on darwin", () => {
		const url = "https://example.com/auth?foo=bar";
		const launch = resolveBrowserLaunch("darwin", url);
		expect(launch.command).toBe("open");
		expect(launch.args).toEqual([url]);
		expect(launch.options.windowsHide).toBeUndefined();
	});

	test("uses xdg-open on linux", () => {
		const url = "https://example.com/auth?foo=bar";
		const launch = resolveBrowserLaunch("linux", url);
		expect(launch.command).toBe("xdg-open");
		expect(launch.args).toEqual([url]);
		expect(launch.options.windowsHide).toBeUndefined();
	});

	test("uses rundll32 on win32 and preserves query params", () => {
		const url =
			"https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc";
		const launch = resolveBrowserLaunch("win32", url);
		expect(launch.command).toBe("rundll32");
		expect(launch.args[0]).toBe("url.dll,FileProtocolHandler");
		expect(launch.args[1]).toBe(url);
		expect(launch.options.windowsHide).toBe(true);
		expect(launch.options.shell).toBeUndefined();
	});
});
