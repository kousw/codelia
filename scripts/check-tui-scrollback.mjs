import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function loadTerminal(dependencyDirectory) {
	assert.ok(
		dependencyDirectory,
		"An isolated @xterm/headless dependency directory is required",
	);
	const require = createRequire(import.meta.url);
	return require(
		require.resolve("@xterm/headless", { paths: [dependencyDirectory] }),
	).Terminal;
}

export async function verifyCapture(Terminal, capture) {
	assert.ok(capture.expected.length > 0 && capture.prefix.length > 0);
	assert.ok(capture.composer && capture.footer.length > 0);
	const terminal = new Terminal({
		cols: capture.cols,
		rows: capture.rows,
		scrollback: 10_000,
		allowProposedApi: true,
	});
	// Observe DECTCEM through the public parser API; returning false preserves
	// the emulator's own handling. Cursor visibility has no public buffer getter.
	let cursorVisible = true;
	const observers = [true, false].map((visible) =>
		terminal.parser.registerCsiHandler(
			{ prefix: "?", final: visible ? "h" : "l" },
			(params) => {
				if (params.includes(25)) cursorVisible = visible;
				return false;
			},
		),
	);
	try {
		await new Promise((resolve) => terminal.write(capture.data, resolve));
		assert.equal(
			terminal.buffer.active.type,
			"normal",
			"Unexpected alternate buffer",
		);
		const buffer = terminal.buffer.normal;
		const lines = Array.from({ length: buffer.length }, (_, index) =>
			buffer.getLine(index).translateToString(true).trimEnd(),
		);
		const transcript = [...capture.prefix, ...capture.expected];
		// Compare every row, including the declared footer/padding. Filtering for
		// markers would hide leaked UI chrome and corrupted duplicate fragments.
		assert.deepEqual(
			lines,
			[...transcript, ...capture.footer],
			"Complete terminal buffer differs",
		);
		assert.ok(
			buffer.baseY > capture.prefix.length,
			"Old output is not in native scrollback",
		);
		assert.ok(
			transcript.length - 1 >= buffer.baseY,
			"Latest output is not visible",
		);
		const composerRows = lines.flatMap((line, index) =>
			line.includes(capture.composer) ? [index] : [],
		);
		assert.equal(composerRows.length, 1, "Composer must appear exactly once");
		const composerRow = composerRows[0];
		assert.ok(composerRow >= buffer.baseY, "Composer leaked into scrollback");
		assert.equal(
			lines[composerRow].indexOf(capture.composer),
			capture.composer_column,
		);
		assert.equal(
			buffer.cursorY + buffer.baseY,
			composerRow,
			"Cursor is not on composer row",
		);
		assert.equal(
			buffer.cursorX,
			capture.composer_column + capture.composer.length,
			"Cursor is not after composer text",
		);
		assert.ok(cursorVisible, "Composer cursor is hidden");
		for (const row of capture.styled_rows) {
			for (const [column, rgb, palette] of [
				[0, 0xff0000, 196],
				[12, 0x00ff00, 46],
				[18, 0x00ff00, 46],
			]) {
				const cell = buffer.getLine(row).getCell(column);
				assert.ok(
					(cell.isFgRGB() && cell.getFgColor() === rgb) ||
						(cell.isFgPalette() && cell.getFgColor() === palette),
					`Wrong foreground at ${row}:${column}`,
				);
				assert.ok(
					cell.isBgRGB() && cell.getBgColor() === 0x242c34,
					`Wrong code background at ${row}:${column}`,
				);
			}
		}
		return `${capture.cols}x${capture.rows}, batch=${capture.batch_size}: ${transcript.length}/${transcript.length} transcript rows; full buffer, styles, composer and cursor verified`;
	} finally {
		for (const observer of observers) observer.dispose();
		terminal.dispose();
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	const [capturePath, dependencyDirectory] = process.argv.slice(2);
	assert.ok(
		capturePath && dependencyDirectory,
		"Usage: node scripts/check-tui-scrollback.mjs <capture.json> <directory containing node_modules/@xterm/headless>",
	);
	const Terminal = loadTerminal(dependencyDirectory);
	const captures = JSON.parse(await readFile(capturePath, "utf8"));
	assert.ok(
		Array.isArray(captures) && captures.length > 0,
		"No captures to replay",
	);
	for (const capture of captures)
		console.log(await verifyCapture(Terminal, capture));
}
