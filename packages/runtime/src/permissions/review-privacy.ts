const credentialShape =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}\b/u;
const credentialAssignment =
	/(?:\b(?:api[\s_-]*key|private[\s_-]*key|pass(?:word|phrase)|credentials?|secret|cookie|bearer|authorization|(?:access[\s_-]*|refresh[\s_-]*)?token)\b|認証情報|秘密鍵|パスワード|トークン|API[\s_-]*キー)(?:\\?["'])?\s*[:=：＝]\s*(?:\\?["'])?[^\s"',;)}\]]/iu;
const credentialArgument =
	/(?:^|\s)--(?:api[-_]?key|password|passphrase|token|access[-_]?token|refresh[-_]?token|credential|secret|authorization|cookie)(?:=|\s+)\S|\b(?:bearer|basic)\s+[A-Za-z0-9_+=./-]{12,}\b/iu;
const credentialProse =
	/\b(?:(?:with|using|use)\s+(?:the\s+)?(?:password|passphrase|token|api key|secret)|my\s+(?:password|passphrase|token|api key|secret)|(?:password|passphrase|token|api key|secret)\s+(?:is|equals))\s+(?!(?:parser|parsing|validation|handling|rotation|implementation|code|support|flow|fixtures?|tests?|authentication)(?=[\s.,;]|$))["']?[^\s.,;"']+/iu;

const urlPattern = /\b(?:[a-z][a-z\d+.-]*:\/\/|file:\/)[^\s<>"'`]+/giu;
const credentialQueryKey =
	/^(?:api[_-]?key|(?:access|refresh|id)[_-]?token|auth(?:orization|[_-]?token)?|(?:client[_-]?)?secret|password|passphrase|token|signature|sig|session[_-]?token|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature))$/iu;

export const reviewUrlReferences = (value: string): URL[] =>
	[...value.matchAll(urlPattern)].flatMap(([reference]) => {
		try {
			return [new URL(reference.replace(/[)\]}>.,;!?。、「」]+$/u, ""))];
		} catch {
			return [];
		}
	});

/** Match credential material and value-bearing syntax. */
export const containsCredentialMaterial = (value: string): boolean =>
	credentialShape.test(value) ||
	credentialAssignment.test(value) ||
	credentialArgument.test(value) ||
	credentialProse.test(value) ||
	reviewUrlReferences(value).some(
		(url) =>
			!!(url.username || url.password) ||
			Array.from(url.searchParams).some(
				([key, parameter]) => !!parameter && credentialQueryKey.test(key),
			),
	);

const sensitiveEnvName =
	/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|COOKIE|AUTHORIZATION|DSN)(?:_|$)/iu;
const flagValue = /^(?:0|1|true|false|yes|no|on|off)$/iu;

/** Snapshot inherited credential values once for a single review operation. */
export function createReviewCredentialDetector(): (value: string) => boolean {
	const escapePattern = (value: string) =>
		value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const sensitiveValues: RegExp[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || !sensitiveEnvName.test(name)) continue;
		const normalized = value.normalize("NFKC");
		if (flagValue.test(normalized)) continue;
		const literal = escapePattern(normalized);
		sensitiveValues.push(
			new RegExp(
				normalized.length < 8
					? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`
					: literal,
				"u",
			),
		);
	}
	return (value) => {
		const normalized = value.normalize("NFKC");
		return (
			containsCredentialMaterial(normalized) ||
			sensitiveValues.some((pattern) => pattern.test(normalized))
		);
	};
}

export const containsReviewCredential = (value: string): boolean =>
	createReviewCredentialDetector()(value);
