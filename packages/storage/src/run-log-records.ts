import { readRunLogChunks } from "./run-log-reader";

const MAX_RECORD_PREFIX_BYTES = 256;
const RECORD_TYPE = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/;

export type RunLogRecordPart = {
	type: string;
	data: Buffer;
	start: boolean;
	end: boolean;
};

/** Identify records from a bounded prefix; never buffer a request/image line. */
export async function* readRunLogRecordParts(
	file: string,
): AsyncGenerator<RunLogRecordPart> {
	let prefix = Buffer.alloc(0);
	let type: string | undefined;
	for await (const chunk of readRunLogChunks(file)) {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const next = newline < 0 ? chunk.length : newline + 1;
			const data = chunk.subarray(offset, next);
			const end = newline >= 0;
			if (type === undefined) {
				const consumed = Math.min(
					MAX_RECORD_PREFIX_BYTES - prefix.length,
					data.length,
				);
				prefix = Buffer.concat([prefix, data.subarray(0, consumed)]);
				const match = RECORD_TYPE.exec(prefix.toString("utf8"));
				if (!match) {
					if (end || prefix.length === MAX_RECORD_PREFIX_BYTES)
						throw new Error("Invalid run log record prefix");
				} else {
					type = match[1];
					yield {
						type,
						data: prefix,
						start: true,
						end: end && consumed === data.length,
					};
					prefix = Buffer.alloc(0);
					if (consumed < data.length)
						yield { type, data: data.subarray(consumed), start: false, end };
				}
			} else yield { type, data, start: false, end };
			if (end) type = undefined;
			offset = next;
		}
	}
	if (type !== undefined || prefix.length)
		throw new Error("Incomplete run log record");
}
