import { defineConfig } from "tsup";

const credentialHelperDigests: Record<string, string> = {};
for (const arch of ["arm64", "x64"]) {
	const digest =
		process.env[`CODELIA_CREDENTIAL_HELPER_SHA256_${arch.toUpperCase()}`];
	if (digest === undefined) continue;
	if (!/^[a-f0-9]{64}$/.test(digest)) {
		throw new Error(`Invalid macOS credential helper digest for ${arch}`);
	}
	credentialHelperDigests[arch] = digest;
}

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	clean: true,
	define: {
		__CODELIA_CREDENTIAL_HELPER_SHA256__: JSON.stringify(
			credentialHelperDigests,
		),
	},
});
