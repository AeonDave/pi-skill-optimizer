/**
 * Deterministic blocking benchmark for the single AUTO skill strategy.
 *
 * The catalog is synthetic: no machine paths, installed skills, or user data.
 * Every printed number is measured during this run.
 */
import { normalizeProfile } from "../src/profile.ts";
import { appendToLatestHumanInput, extractRequestQuery, normalizeRequest } from "../src/request.ts";
import {
	optimizeSkillCatalog,
	parseSkills,
	renderSkillPrefetch,
	renderStableSkillCatalog,
	searchSkillCatalog,
	type Skill,
	type SkillCatalogOptimizationResult,
	type SkillPrefetchOptions,
	type StableCatalogOptions,
} from "../src/skills.ts";

const TOPICS: Record<string, string[]> = {
	crypto: ["rsa", "key", "cipher", "hash", "decrypt", "factor"],
	web: ["http", "sqli", "xss", "request", "cookie", "header"],
	python: ["python", "pytest", "module", "fixture", "typing"],
	binary: ["binary", "disassemble", "decompile", "stack", "gadget"],
	network: ["scan", "port", "packet", "dns", "subdomain"],
	cloud: ["cloud", "bucket", "iam", "container", "orchestrate"],
	forensics: ["memory", "dump", "artifact", "timeline", "registry"],
	mobile: ["android", "package", "dex", "instrument", "mobile"],
};
const PER_TOPIC = 35;
const BEHAVIOURAL = ["operator-discipline", "plan-first", "verify-done", "evidence-first"];
const ROOTS = ["/synthetic/skills/a", "/synthetic/skills/b"];

interface SyntheticSkill extends Skill {
	topic: string;
}

interface LabeledCase {
	topic: string;
	query: string;
}

function rng(seed: number): () => number {
	return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSkills(): SyntheticSkill[] {
	const random = rng(99);
	const skills: SyntheticSkill[] = [];
	const sample = (tokens: string[], count: number): string =>
		Array.from({ length: count }, () => tokens[Math.floor(random() * tokens.length)]).join(" ");
	for (const [topic, tokens] of Object.entries(TOPICS)) {
		for (let index = 0; index < PER_TOPIC; index++) {
			const name = `${topic}-${index}`;
			const description = `${topic} utility ${index}: ${sample(tokens, 5)}. Use for ${topic} tasks involving ${sample(tokens, 2)}.`;
			const root = ROOTS[Math.floor(random() * ROOTS.length)];
			const location = index % 9 === 0
				? `/synthetic/irregular/${name}-custom.md`
				: `${root}/${name}/SKILL.md`;
			skills.push({ name, description, location, topic });
		}
	}
	for (const name of BEHAVIOURAL) {
		skills.push({
			name,
			description: `Always-on discipline that enforces ${name} conduct across every session.`,
			location: `${ROOTS[0]}/${name}/SKILL.md`,
			topic: "_behavioural",
		});
	}
	return skills;
}

function renderOriginalCatalog(skills: readonly SyntheticSkill[]): string {
	const lines = ["<available_skills>"];
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.location)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function parsedCatalogSkills(text: string): Skill[] {
	const match = text.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
	return match ? parseSkills(match[1]) : [];
}

function eagerText(result: SkillCatalogOptimizationResult): string {
	const overlay = renderSkillPrefetch(result.plan);
	return overlay.trim() ? `${result.text}\n\n${overlay}` : result.text;
}

const SKILLS = buildSkills();
const CATALOG = renderOriginalCatalog(SKILLS);
const ORIGINAL_BY_NAME = new Map(SKILLS.map((skill) => [skill.name, skill] as const));
const EXPECTED_NAMES = SKILLS.map((skill) => skill.name);
const EXPECTED_NAME_SET = new Set(EXPECTED_NAMES);
const PROFILE = normalizeProfile({
	critical: BEHAVIOURAL,
	aliases: { codename: ["crypto"] },
});
const AUTO_OPTIONS: SkillPrefetchOptions & StableCatalogOptions = {
	profile: PROFILE,
	always: BEHAVIOURAL,
	targetTopK: 20,
	minTopK: 8,
	maxTopK: 32,
	fullRenderBudgetChars: 12_000,
	fuzzyCandidateLimit: 8,
};
const LABELED: LabeledCase[] = Object.keys(TOPICS).map((topic) => ({
	topic,
	query: `${topic} ${TOPICS[topic].slice(0, 3).join(" ")}`,
}));

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function overlayIsVerbatim(result: SkillCatalogOptimizationResult): boolean {
	const rendered = parseSkills(renderSkillPrefetch(result.plan));
	if (!sameNames(rendered.map((skill) => skill.name), result.plan.selectedNames)) return false;
	return rendered.every((skill) => {
		const original = ORIGINAL_BY_NAME.get(skill.name);
		return original !== undefined
			&& skill.description === original.description
			&& skill.location === "";
	});
}

function topicSelections(result: SkillCatalogOptimizationResult, topic: string): string[] {
	return result.plan.selectedNames.filter((name) => name.startsWith(`${topic}-`));
}

const stable = renderStableSkillCatalog(CATALOG);
const stableNames = parsedCatalogSkills(stable.text).map((skill) => skill.name);
const basePreservesNames = sameNames(stableNames, EXPECTED_NAMES);
const baseHasResolverMarker = stable.text.includes("<!--skill-optimizer:auto:v2-->")
	&& stable.text.includes('<skill_index format="tsv" columns="name,intent">')
	&& !stable.text.includes("<location>");
const registryPreservesLocations = stable.skills.every((skill) =>
	ORIGINAL_BY_NAME.get(skill.name)?.location === skill.location);
const registryByName = new Map(stable.skills.map((skill) => [skill.name, skill] as const));
const resolverLoadable = stable.skills.length === SKILLS.length && stableNames.every((name) => {
	const registered = registryByName.get(name);
	const original = ORIGINAL_BY_NAME.get(name);
	return registered !== undefined
		&& original !== undefined
		&& registered.description === original.description
		&& registered.location === original.location
		&& registered.location.length > 0;
});

let baseQueryIndependent = true;
let overlayVerbatim = true;
let queryAwareCases = 0;
let neverWorseCases = 0;
let selectedTotal = 0;
let relevantSelected = 0;
let ordinarySelected = 0;
let baseSavedTotal = 0;
let eagerSavedTotal = 0;
const labeledResults: SkillCatalogOptimizationResult[] = [];
for (const example of LABELED) {
	const result = optimizeSkillCatalog(CATALOG, example.query, AUTO_OPTIONS);
	labeledResults.push(result);
	baseQueryIndependent &&= result.text === stable.text && result.fingerprint === stable.fingerprint;
	overlayVerbatim &&= overlayIsVerbatim(result);
	const relevant = topicSelections(result, example.topic);
	if (relevant.length > 0) queryAwareCases += 1;
	const ordinary = result.plan.selectedNames.filter((name) => !BEHAVIOURAL.includes(name));
	relevantSelected += relevant.length;
	ordinarySelected += ordinary.length;
	selectedTotal += result.plan.selectedNames.length;
	const eager = eagerText(result);
	if (eager.length <= CATALOG.length) neverWorseCases += 1;
	baseSavedTotal += CATALOG.length - result.text.length;
	eagerSavedTotal += CATALOG.length - eager.length;
}

const noSignal = optimizeSkillCatalog(CATALOG, "🔥 日本語 qzxvplm", AUTO_OPTIONS);
const noSignalOrdinary = noSignal.plan.selectedNames.filter((name) => !BEHAVIOURAL.includes(name));
const noSignalSafe = !noSignal.plan.hasSignal
	&& noSignalOrdinary.length === 0
	&& BEHAVIOURAL.every((name) => noSignal.plan.selectedNames.includes(name))
	&& eagerText(noSignal).length <= CATALOG.length;

const deterministicFirst = optimizeSkillCatalog(CATALOG, "crypto rsa key", AUTO_OPTIONS);
const deterministicSecond = optimizeSkillCatalog(CATALOG, "crypto rsa key", AUTO_OPTIONS);
const deterministic = deterministicFirst.text === deterministicSecond.text
	&& deterministicFirst.fingerprint === deterministicSecond.fingerprint
	&& JSON.stringify(deterministicFirst.plan.selectedNames) === JSON.stringify(deterministicSecond.plan.selectedNames)
	&& JSON.stringify(deterministicFirst.plan.ranked) === JSON.stringify(deterministicSecond.plan.ranked)
	&& renderSkillPrefetch(deterministicFirst.plan) === renderSkillPrefetch(deterministicSecond.plan);
const rerendered = renderStableSkillCatalog(stable.text);
const idempotent = rerendered.text === stable.text
	&& rerendered.removedChars === 0;

const LATEST_HUMAN = "mobile android dex instrument";
const PREFETCH_ATTACHMENT_MARKER = "<!--skill-prefetch-attachment:auto:v2-->";
const providerPayloads: unknown[] = [
	{
		messages: [
			{ role: "user", content: "crypto rsa historical request" },
			{ role: "assistant", content: "historical answer" },
			{ role: "user", content: LATEST_HUMAN },
		],
	},
	{
		input: [
			{ role: "user", content: [{ type: "input_text", text: "crypto rsa historical request" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "historical answer" }] },
			{ role: "user", content: [{ type: "input_text", text: LATEST_HUMAN }] },
		],
	},
	{
		contents: [
			{ role: "user", parts: [{ text: "crypto rsa historical request" }] },
			{ role: "model", parts: [{ text: "historical answer" }] },
			{ role: "user", parts: [{ text: LATEST_HUMAN }] },
		],
	},
];

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
		? (part as { text: string }).text
		: "").filter(Boolean).join("\n");
}

function humanTexts(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") return [];
	const record = payload as Record<string, unknown>;
	for (const field of ["messages", "input"] as const) {
		const entries = record[field];
		if (!Array.isArray(entries)) continue;
		return entries
			.filter((entry) => entry && typeof entry === "object" && ["user", "human"].includes(String((entry as { role?: unknown }).role)))
			.map((entry) => contentText((entry as { content?: unknown }).content));
	}
	if (!Array.isArray(record.contents)) return [];
	return record.contents
		.filter((entry) => entry && typeof entry === "object" && (entry as { role?: unknown }).role === "user")
		.map((entry) => contentText((entry as { parts?: unknown }).parts));
}

const providerChecks = providerPayloads.map((payload) => {
	const query = extractRequestQuery(normalizeRequest(payload));
	const result = optimizeSkillCatalog(CATALOG, query, AUTO_OPTIONS);
	const overlay = renderSkillPrefetch(result.plan);
	const before = humanTexts(payload);
	const attached = appendToLatestHumanInput(payload, overlay, PREFETCH_ATTACHMENT_MARKER);
	const after = humanTexts(attached);
	const expectedLatest = `${before.at(-1)}\n${PREFETCH_ATTACHMENT_MARKER}\n${overlay}`;
	const latestOnly = before.length === after.length
		&& JSON.stringify(before.slice(0, -1)) === JSON.stringify(after.slice(0, -1))
		&& after.at(-1) === expectedLatest;
	const attachmentIdempotent = appendToLatestHumanInput(attached, overlay, PREFETCH_ATTACHMENT_MARKER) === attached;
	return {
		query,
		latestHumanQuery: query === LATEST_HUMAN,
		mobileHit: topicSelections(result, "mobile").length > 0,
		overlayVerbatim: overlayIsVerbatim(result),
		latestOnly,
		attachmentIdempotent,
	};
});
const providerShapes = providerChecks.every((check) =>
	check.latestHumanQuery && check.mobileHit && check.overlayVerbatim && check.latestOnly && check.attachmentIdempotent);

const fuzzyLimit = 3;
const fuzzy = searchSkillCatalog(stable.skills, "cryptp-7", {
	profile: PROFILE,
	fuzzyCandidateLimit: fuzzyLimit,
	pageSize: 10,
});
const fuzzyItems = fuzzy.items.filter((item) => item.reasons.includes("fuzzy"));
const fuzzyBounded = fuzzy.items.some((item) => item.name === "crypto-7" && item.reasons.includes("fuzzy"))
	&& fuzzyItems.length > 0
	&& fuzzyItems.length <= fuzzyLimit
	&& fuzzy.total <= fuzzyLimit;
if (!providerShapes) console.error(`provider diagnostics: ${JSON.stringify(providerChecks)}`);
if (!fuzzyBounded) console.error(`fuzzy diagnostics: ${JSON.stringify(fuzzy)}`);

const excluded = optimizeSkillCatalog(CATALOG, "crypto rsa", {
	...AUTO_OPTIONS,
	never: ["crypto-0", "web-*"],
});
const exclusionSafe = !parsedCatalogSkills(excluded.text).some((skill) =>
	skill.name === "crypto-0" || skill.name.startsWith("web-"))
	&& !excluded.plan.selectedNames.some((name) => name === "crypto-0" || name.startsWith("web-"));

const VOCAB = [...new Set(SKILLS.flatMap((skill) =>
	skill.description.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)))];
const JUNK = ["", "   ", "<script>", "&amp;", "../../x", "日本語", "🔥", "zzzz", "1234"];
const random = rng(2025);
function fuzzQuery(): string {
	const count = Math.floor(random() * 8);
	const parts: string[] = [];
	for (let index = 0; index < count; index++) {
		parts.push(random() < 0.8
			? VOCAB[Math.floor(random() * VOCAB.length)]
			: JUNK[Math.floor(random() * JUNK.length)]);
	}
	return parts.join(" ");
}

const FUZZ_CASES = 2_000;
let fuzzCrashes = 0;
let fuzzBaseChanges = 0;
let fuzzNameFailures = 0;
let fuzzOverlayFailures = 0;
let fuzzNeverWorseFailures = 0;
for (let index = 0; index < FUZZ_CASES; index++) {
	try {
		const result = optimizeSkillCatalog(CATALOG, fuzzQuery(), AUTO_OPTIONS);
		if (result.text !== stable.text || result.fingerprint !== stable.fingerprint) fuzzBaseChanges += 1;
		if (!sameNames(parsedCatalogSkills(result.text).map((skill) => skill.name), EXPECTED_NAMES)) fuzzNameFailures += 1;
		if (!overlayIsVerbatim(result)) fuzzOverlayFailures += 1;
		if (eagerText(result).length > CATALOG.length) fuzzNeverWorseFailures += 1;
	} catch {
		fuzzCrashes += 1;
	}
}

const averageSelected = selectedTotal / LABELED.length;
const baseSavedPercent = (100 * baseSavedTotal) / (CATALOG.length * LABELED.length);
const eagerSavedPercent = (100 * eagerSavedTotal) / (CATALOG.length * LABELED.length);
const precision = relevantSelected / Math.max(1, ordinarySelected);
const estimatedTokens = (chars: number): number => Math.round(chars / 4);

console.log(`synthetic catalog: ${SKILLS.length} skills, ${CATALOG.length} chars (~${estimatedTokens(CATALOG.length)} estimated tokens)`);
console.log("strategy | base saved | eager saved | avg prefetch | topic hit | precision | never worse");
console.log("---------|------------|-------------|--------------|-----------|-----------|------------");
console.log(
	`AUTO     | ${`${Math.round(baseSavedPercent)}%`.padStart(10)} | ${`${Math.round(eagerSavedPercent)}%`.padStart(11)} | ${averageSelected.toFixed(1).padStart(12)} | ${`${queryAwareCases}/${LABELED.length}`.padStart(9)} | ${`${Math.round(precision * 100)}%`.padStart(9)} | ${`${neverWorseCases}/${LABELED.length}`.padStart(10)}`,
);
console.log(
	`base: names=${basePreservesNames} marker=${baseHasResolverMarker} registry=${registryPreservesLocations} resolver=${resolverLoadable} query-independent=${baseQueryIndependent}`,
);
console.log(
	`overlay: verbatim=${overlayVerbatim} no-signal=${noSignalSafe} deterministic=${deterministic} idempotent=${idempotent} provider-shapes=${providerShapes} fuzzy-bounded=${fuzzyBounded} exclusions=${exclusionSafe}`,
);
console.log(
	`fuzz ${FUZZ_CASES}: crashes=${fuzzCrashes} baseChanges=${fuzzBaseChanges} nameFailures=${fuzzNameFailures} overlayFailures=${fuzzOverlayFailures} neverWorseFailures=${fuzzNeverWorseFailures}`,
);

const invariantFailure = !basePreservesNames
	|| !baseHasResolverMarker
	|| !registryPreservesLocations
	|| !resolverLoadable
	|| !baseQueryIndependent
	|| !overlayVerbatim
	|| queryAwareCases !== LABELED.length
	|| neverWorseCases !== LABELED.length
	|| !noSignalSafe
	|| !deterministic
	|| !idempotent
	|| !providerShapes
	|| !fuzzyBounded
	|| !exclusionSafe
	|| fuzzy.total > fuzzyLimit
	|| labeledResults.length !== LABELED.length
	|| fuzzCrashes > 0
	|| fuzzBaseChanges > 0
	|| fuzzNameFailures > 0
	|| fuzzOverlayFailures > 0
	|| fuzzNeverWorseFailures > 0
	|| !sameNames(stableNames, EXPECTED_NAMES)
	|| !EXPECTED_NAMES.every((name) => EXPECTED_NAME_SET.has(name));
if (invariantFailure) process.exitCode = 1;
