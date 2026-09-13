import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTerminal, verifyCapture } from "./check-tui-scrollback.mjs";

const capturePath = process.env.CODELIA_TUI_CAPTURE_PATH;
assert.ok(
	capturePath,
	"Set CODELIA_TUI_CAPTURE_PATH to the production ANSI fixture",
);
const Terminal = loadTerminal(process.env.CODELIA_TUI_EMULATOR_DIR);
const captures = JSON.parse(await readFile(capturePath, "utf8"));
assert.ok(captures.length > 0);

for (const capture of captures) {
	test(`production output ${capture.cols}x${capture.rows}, batch ${capture.batch_size}`, async () => {
		await verifyCapture(Terminal, capture);
	});
}

const capture = captures[0];
const footerStart = capture.rows - capture.footer.length;
const composerRow =
	footerStart +
	capture.footer.findIndex((line) => line.includes(capture.composer)) +
	1;
const negativeCases = [
	[
		"extra history/UI row despite retained markers",
		`\x1b[${capture.rows};1H\r\nLEAKED-UI`,
		/Complete terminal buffer differs/,
	],
	[
		"extra blank row",
		`\x1b[${capture.rows};1H\r\n`,
		/Complete terminal buffer differs/,
	],
	[
		"missing composer",
		`\x1b[${composerRow};1H\x1b[2K`,
		/Complete terminal buffer differs/,
	],
	["hidden cursor", "\x1b[?25l", /Composer cursor is hidden/],
	["misplaced cursor", "\x1b[1;1H", /Cursor is not on composer row/],
	["alternate screen", "\x1b[?1049h", /Unexpected alternate buffer/],
];
for (const [name, suffix, error] of negativeCases) {
	test(`rejects ${name}`, async () => {
		await assert.rejects(
			verifyCapture(Terminal, { ...capture, data: capture.data + suffix }),
			error,
		);
	});
}

test("rejects lost code colors even with identical characters", async () => {
	// The last styled log row is still visible. Rewrite only its red prefix in
	// default colors, then restore the cursor so only the style check catches it.
	const bufferLength =
		capture.prefix.length + capture.expected.length + capture.footer.length;
	const row = capture.styled_rows.at(-1);
	const screenRow = row - (bufferLength - capture.rows) + 1;
	const text = capture.expected[row - capture.prefix.length].slice(0, 12);
	const suffix = `\x1b[${screenRow};1H\x1b[0m${text}\x1b[${composerRow};${capture.composer_column + capture.composer.length + 1}H`;
	await assert.rejects(
		verifyCapture(Terminal, { ...capture, data: capture.data + suffix }),
		/Wrong foreground/,
	);
});
