/**
 * Candidate lexical aliases for short queries that may not share terms with
 * skill descriptions. They are filtered per catalog, so aliases only expand to
 * terms actually present in the user's available skills.
 */

export type QueryAliasMap = ReadonlyMap<string, readonly string[]>;
export type AliasRecord = Record<string, string[]>;

export const CANDIDATE_QUERY_ALIASES: Readonly<Record<string, readonly string[]>> = {
	ad: ["active", "directory", "kerberos", "ldap", "windows"],
	apk: ["android", "mobile", "reverse"],
	aws: ["cloud", "iam", "s3"],
	azure: ["cloud", "entra", "oauth"],
	csharp: ["dotnet", "windows"],
	docker: ["container", "kubernetes"],
	hash: ["password", "cracking"],
	htb: ["hackthebox", "vpn", "machine"],
	jwt: ["token", "oauth"],
	k8s: ["kubernetes", "container"],
	ntlm: ["hash", "password", "smb", "windows"],
	pcap: ["packet", "capture", "network"],
	plugin: ["extension", "package"],
	plugins: ["extension", "package"],
	pr: ["pull", "request", "github"],
	rsa: ["crypto", "cryptography", "key"],
	smb: ["windows", "active", "directory"],
	ts: ["typescript"],
	tsc: ["typescript", "typecheck"],
	typecheck: ["typescript", "tsc"],
	web3: ["blockchain", "ethereum", "evm"],
};

const OVERBROAD_ALIAS_TARGETS = new Set([
	"assessment",
	"reference",
	"security",
	"technique",
	"tool",
	"tools",
	"workflow",
]);

let userAliasCandidates: AliasRecord = {};
let userAliasRevision = 0;

function aliasRecordsEqual(left: AliasRecord, right: AliasRecord): boolean {
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	if (leftEntries.length !== rightEntries.length) return false;
	return leftEntries.every(([key, targets]) => {
		const other = right[key];
		return other !== undefined && targets.length === other.length && targets.every((target, i) => target === other[i]);
	});
}

function normalizeToken(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2 && /[a-z]/.test(token));
}

export function normalizeAliasRecord(value: unknown): AliasRecord {
	const out: AliasRecord = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [rawKey, rawTargets] of Object.entries(value)) {
		if (!Array.isArray(rawTargets)) continue;
		const keys = normalizeToken(rawKey);
		const targets = Array.from(
			new Set(rawTargets.flatMap((target) => (typeof target === "string" ? normalizeToken(target) : []))),
		);
		if (targets.length === 0) continue;
		for (const key of keys) out[key] = Array.from(new Set([...(out[key] ?? []), ...targets]));
	}
	return out;
}

export function setUserAliasCandidates(value: unknown): AliasRecord {
	const normalized = normalizeAliasRecord(value);
	if (!aliasRecordsEqual(userAliasCandidates, normalized)) {
		userAliasCandidates = normalized;
		userAliasRevision += 1;
	}
	return userAliasCandidates;
}

/** Monotonic revision used to invalidate catalog analyses that captured global aliases. */
export function getUserAliasRevision(): number {
	return userAliasRevision;
}

export function buildCatalogAliases(hasTerm: (term: string) => boolean, extraCandidates: AliasRecord = {}): QueryAliasMap {
	const aliases = new Map<string, readonly string[]>();
	const merged = new Map<string, string[]>();
	for (const [source, targets] of Object.entries(CANDIDATE_QUERY_ALIASES)) merged.set(source, [...targets]);
	for (const [source, targets] of Object.entries(userAliasCandidates)) {
		merged.set(source, Array.from(new Set([...(merged.get(source) ?? []), ...targets])));
	}
	for (const [source, targets] of Object.entries(extraCandidates)) {
		merged.set(source, Array.from(new Set([...(merged.get(source) ?? []), ...targets])));
	}
	for (const [source, targets] of merged) {
		const presentTargets = targets.filter((target) => hasTerm(target) && !OVERBROAD_ALIAS_TARGETS.has(target));
		if (presentTargets.length > 0) aliases.set(source, presentTargets);
	}
	return aliases;
}

export function expandQueryTokens(tokens: readonly string[], aliases: QueryAliasMap): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	const add = (token: string): void => {
		if (seen.has(token)) return;
		seen.add(token);
		expanded.push(token);
	};
	for (const token of tokens) {
		add(token);
		for (const alias of aliases.get(token) ?? []) add(alias);
	}
	return expanded;
}
