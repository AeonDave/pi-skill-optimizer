export type QueryAliasMap = ReadonlyMap<string, readonly string[]>;
export type AliasRecord = Record<string, string[]>;

// Static, reviewed vocabulary only. Catalog filtering below prevents an alias
// from adding terms that do not exist in the active catalog.
export const CANDIDATE_QUERY_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	ad: ["active", "directory", "kerberos", "ldap"],
	adb: ["android", "mobile"],
	apk: ["android", "mobile", "application"],
	authn: ["authentication", "identity"],
	authz: ["authorization", "permission"],
	aws: ["cloud", "amazon"],
	azure: ["cloud", "microsoft"],
	binary: ["reverse", "reversing", "exploitation"],
	bug: ["debug", "debugging", "defect"],
	ci: ["cicd", "pipeline"],
	cli: ["command", "shell"],
	container: ["docker", "kubernetes"],
	crack: ["cracking", "password", "hash"],
	ctf: ["challenge", "exploit"],
	db: ["database", "sql"],
	debug: ["debugging", "gdb", "windbg"],
	deploy: ["deployment", "release"],
	docker: ["container"],
	forensic: ["forensics", "artifact"],
	fuzz: ["fuzzer", "fuzzing"],
	git: ["github", "repository"],
	incident: ["forensics", "response"],
	js: ["javascript", "typescript", "node"],
	k8s: ["kubernetes", "container"],
	malware: ["reverse", "analysis"],
	mobile: ["android", "ios", "application"],
	network: ["packet", "traffic", "protocol"],
	osint: ["intelligence", "reconnaissance"],
	pentest: ["security", "assessment"],
	plugin: ["extension"],
	pr: ["pull", "request", "review"],
	pwn: ["binary", "exploitation"],
	py: ["python"],
	recon: ["reconnaissance", "discovery", "enumeration"],
	recover: ["recovery"],
	refactor: ["architecture", "design"],
	reverse: ["reversing", "analysis"],
	rtk: ["output", "compression"],
	sqli: ["sql", "injection"],
	test: ["testing", "tests"],
	token: ["context", "prompt"],
	tunnel: ["pivot", "proxy"],
	vuln: ["vulnerability", "security"],
	web: ["http", "browser"],
});

const OVERBROAD_TARGETS = new Set(["app", "code", "file", "tool", "use", "workflow"]);

function normalizeToken(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}#+.-]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

export function normalizeAliasRecord(value: unknown): AliasRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: AliasRecord = {};
	for (const [rawSource, rawTargets] of Object.entries(value)) {
		const source = normalizeToken(rawSource);
		if (!source || !Array.isArray(rawTargets)) continue;
		const targets = [...new Set(rawTargets
			.filter((target): target is string => typeof target === "string")
			.map(normalizeToken)
			.filter((target) => target && target !== source && !OVERBROAD_TARGETS.has(target)))];
		if (targets.length > 0) out[source] = targets;
	}
	return out;
}

/** Build an immutable alias view scoped to one catalog. */
export function buildCatalogAliases(
	hasTerm: (term: string) => boolean,
	extraCandidates: AliasRecord = {},
): QueryAliasMap {
	const candidates = { ...CANDIDATE_QUERY_ALIASES, ...normalizeAliasRecord(extraCandidates) };
	const aliases = new Map<string, readonly string[]>();
	for (const [source, rawTargets] of Object.entries(candidates)) {
		const targets = [...new Set(rawTargets
			.map(normalizeToken)
			.filter((target) => target && !OVERBROAD_TARGETS.has(target) && hasTerm(target)))];
		if (targets.length > 0) aliases.set(normalizeToken(source), Object.freeze(targets));
	}
	return aliases;
}

export function expandQueryTokens(tokens: readonly string[], aliases: QueryAliasMap): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	for (const rawToken of tokens) {
		const token = normalizeToken(rawToken);
		if (!token || seen.has(token)) continue;
		seen.add(token);
		expanded.push(token);
		for (const target of aliases.get(token) ?? []) {
			if (seen.has(target)) continue;
			seen.add(target);
			expanded.push(target);
		}
	}
	return expanded;
}
