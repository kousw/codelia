import {
	authLockPathFor,
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	KeychainError,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
	resolveStoragePaths,
	withAuthStoreLock,
} from "@codelia/storage";

const USAGE = "usage: codelia auth authorize-keychain";

export const runAuthCommand = async (args: string[]): Promise<number> => {
	if (args.length === 1 && ["-h", "--help", "help"].includes(args[0])) {
		console.log(USAGE);
		return 0;
	}
	if (args.length !== 1 || args[0] !== "authorize-keychain") {
		console.error(USAGE);
		return 1;
	}
	if (
		process.platform !== "darwin" ||
		!process.stdin.isTTY ||
		!process.stderr.isTTY
	) {
		console.error("Run this command from a local macOS terminal.");
		return 1;
	}

	try {
		const paths = resolveStoragePaths();
		const client = new MacOsKeychainClient();
		const account = keychainAccountForConfigDir(paths.configDir);
		const probe = await client.probe();
		if (!probe.available) {
			console.error(probe.message);
			return 1;
		}
		console.error(
			"If macOS requests access, choose Always Allow to authorize Keychain access.",
		);
		let failed = false;
		await withAuthStoreLock(authLockPathFor(paths.credentialsDir), async () => {
			for (const service of [
				CODELIA_AUTH_KEYCHAIN_SERVICE,
				CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
			]) {
				try {
					const found = await client.authorize(service, account);
					console.log(
						`${service}: ${found ? "access granted" : "no item found"}`,
					);
				} catch (error) {
					failed = true;
					const message =
						error instanceof KeychainError
							? error.message
							: "Keychain authorization failed.";
					console.error(`${service}: ${message}`);
				}
			}
		});
		return failed ? 1 : 0;
	} catch (error) {
		console.error(
			error instanceof KeychainError
				? error.message
				: "Keychain authorization failed.",
		);
		return 1;
	}
};
