import { promisify } from "node:util";
import { inflate } from "node:zlib";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const inflateAsync = promisify(inflate);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (data: Uint8Array) => {
	let crc = 0xffffffff;
	for (const b of data) crc = (crcTable[(crc ^ b) & 255] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
};
const invalid = (): never => {
	throw new Error(
		"Invalid or unsupported image: require a complete non-interlaced 8-bit PNG, <=8 MiB, <=4096 per side and <=16 MP.",
	);
};

/** Validate chunks, CRC and bounded decompression before accepting provider bytes. */
export async function validateImagePng(
	bytes: Buffer,
): Promise<{ width: number; height: number }> {
	if (
		bytes.length < 57 ||
		bytes.length > IMAGE_MAX_BYTES ||
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	)
		invalid();
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	let ended = false;
	let dataEnded = false;
	let palette = false;
	let color = -1;
	const data: Buffer[] = [];
	while (offset + 12 <= bytes.length) {
		const len = bytes.readUInt32BE(offset);
		if (offset + 12 + len > bytes.length) invalid();
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const payload = bytes.subarray(offset + 8, offset + 8 + len);
		if (
			crc32(bytes.subarray(offset + 4, offset + 8 + len)) !==
			bytes.readUInt32BE(offset + 8 + len)
		)
			invalid();
		if (offset === 8 && type !== "IHDR") invalid();
		if (type === "IHDR") {
			if (offset !== 8 || len !== 13) invalid();
			width = payload.readUInt32BE(0);
			height = payload.readUInt32BE(4);
			color = payload[9] ?? -1;
			channels =
				({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ??
				0;
			if (
				!width ||
				!height ||
				width > 4096 ||
				height > 4096 ||
				width * height > 16_000_000 ||
				!channels ||
				payload[8] !== 8 ||
				payload[10] !== 0 ||
				payload[11] !== 0 ||
				payload[12] !== 0
			)
				invalid();
		} else if (type === "IDAT") {
			if (dataEnded || (color === 3 && !palette)) invalid();
			data.push(payload);
		} else if (type === "IEND") {
			if (len !== 0 || !data.length) invalid();
			ended = true;
			offset += 12;
			break;
		} else {
			if (data.length) dataEnded = true;
			if (type === "PLTE") {
				if (palette || data.length || len === 0 || len > 768 || len % 3)
					invalid();
				palette = true;
			} else if (!/^[a-z][A-Za-z]{3}$/.test(type) || type === "acTL") invalid();
		}
		offset += 12 + len;
	}
	if (!ended || offset !== bytes.length) invalid();
	const rowBytes = width * channels + 1;
	try {
		const raw = await inflateAsync(Buffer.concat(data), {
			maxOutputLength: rowBytes * height,
		});
		if (raw.length !== rowBytes * height) invalid();
		for (let row = 0; row < height; row++)
			if ((raw[row * rowBytes] ?? 255) > 4) invalid();
	} catch {
		invalid();
	}
	return { width, height };
}
