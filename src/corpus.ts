/**
 * Pure helpers for building a private, shareable optimization corpus.
 *
 * Raw values are never retained by these APIs. Stable identifiers are one-way
 * HMACs, redaction uses non-reversible category markers, and skill roots are
 * replaced with deterministic placeholders scoped to one catalog.
 */

import { createHmac } from "node:crypto";

export const CORPUS_SCHEMA_VERSION = 1 as const;

export type CorpusSchemaVersion = typeof CORPUS_SCHEMA_VERSION;
export type CorpusExampleKind = "catalog" | "skill" | "output";

export interface CorpusSkillV1 {
	name: string;
	description: string;
	location: string;
}

export interface CatalogExampleV1 {
	id: string;
	label: string;
	skills: CorpusSkillV1[];
}

export interface SkillExampleV1 {
	id: string;
	label: string;
	catalogId: string;
	query: string;
	relevantSkillNames: string[];
}

export interface OutputExampleV1 {
	id: string;
	label: string;
	tool: string;
	text: string;
	evidence: string[];
}

export interface PrivateCorpusV1 {
	schemaVersion: CorpusSchemaVersion;
	catalogs: CatalogExampleV1[];
	skillExamples: SkillExampleV1[];
	outputExamples: OutputExampleV1[];
}

export interface RawCorpusSkill {
	name: string;
	description: string;
	location: string;
}

export interface RawCatalogExampleV1 {
	label: string;
	skills: readonly RawCorpusSkill[];
}

export interface RawSkillExampleV1 {
	label: string;
	catalogId: string;
	query: string;
	relevantSkillNames: readonly string[];
}

export interface RawOutputExampleV1 {
	label: string;
	tool: string;
	text: string;
	evidence: readonly string[];
}

export type CorpusValidationCode =
	| "invalid-shape"
	| "invalid-schema-version"
	| "missing-id"
	| "duplicate-id"
	| "missing-label"
	| "unsafe-content"
	| "invalid-location"
	| "duplicate-skill-name"
	| "missing-catalog-reference"
	| "unknown-relevant-skill"
	| "missing-evidence";

export interface CorpusValidationIssue {
	code: CorpusValidationCode;
	path: string;
	message: string;
}

export interface CorpusValidationResult {
	valid: boolean;
	issues: CorpusValidationIssue[];
}

export interface EvidenceRecallResult {
	expected: number;
	matched: number;
	recall: number;
	missing: string[];
	complete: boolean;
}

const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\b(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED_TOKEN_RE = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi;
const PREFIXED_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const URL_AUTHORITY_RE = /\b(https?:\/\/)(?:[^@\s/]+@)?(\[[^\]]+\]|[^:/\s?#<>]+)(:\d+)?/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOME_RE = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s<>"']+|\/(?:home|Users)\/[^/\s<>"']+)/g;
const TILDE_HOME_RE = /(^|[^A-Za-z0-9_])~(?=[\\/])/g;
const UNC_PATH_RE = /\\\\[^\\\s<>"']+\\[^\\\s<>"']+(?:\\[^\\\s<>"']+)*/g;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:[\\/](?:[^\\/\s<>"']+[\\/]?)+/g;
const POSIX_ABSOLUTE_PATH_RE = /(?<![A-Za-z0-9_>])(?:\/[^/\s<>"']+){2,}/g;

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("stable ID input must contain only finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
	if (typeof value === "object") {
		if (seen.has(value)) throw new TypeError("stable ID input must not be cyclic");
		seen.add(value);
		const record = value as Record<string, unknown>;
		const fields = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`);
		seen.delete(value);
		return `{${fields.join(",")}}`;
	}
	throw new TypeError(`stable ID input contains unsupported ${typeof value}`);
}

/** Build a deterministic, non-reversible 128-bit identifier with an explicit salt. */
export function stableCorpusId(salt: string, kind: CorpusExampleKind, value: unknown): string {
	if (typeof salt !== "string" || salt.length < 16) throw new TypeError("corpus HMAC salt must contain at least 16 characters");
	const digest = createHmac("sha256", salt)
		.update(`${CORPUS_SCHEMA_VERSION}\0${kind}\0${stableSerialize(value)}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return `${kind}_${digest}`;
}

function validIpv4(value: string): boolean {
	return value.split(".").every((part) => {
		const octet = Number(part);
		return Number.isInteger(octet) && octet >= 0 && octet <= 255;
	});
}

/**
 * Redact common secrets and identifiers without returning or retaining a map.
 * Repeated values intentionally collapse to the same category marker.
 */
export function redactSensitiveText(text: string): string {
	return text
		.replace(PEM_BLOCK_RE, "<PEM_SECRET>")
		.replace(JWT_RE, "<JWT>")
		.replace(BEARER_RE, "$1<API_TOKEN>")
		.replace(NAMED_TOKEN_RE, (_match, key: string) => `${key}=<API_TOKEN>`)
		.replace(PREFIXED_TOKEN_RE, "<API_TOKEN>")
		.replace(URL_AUTHORITY_RE, (_match, scheme: string, _host: string, port: string | undefined) => `${scheme}<URL_HOST>${port ?? ""}`)
		.replace(EMAIL_RE, "<EMAIL>")
		.replace(UUID_RE, "<UUID>")
		.replace(IPV4_RE, (value) => validIpv4(value) ? "<IPV4>" : value)
		.replace(HOME_RE, "<HOME>")
		.replace(TILDE_HOME_RE, "$1<HOME>")
		.replace(UNC_PATH_RE, "<ABS_PATH>")
		.replace(WINDOWS_ABSOLUTE_PATH_RE, "<ABS_PATH>")
		.replace(POSIX_ABSOLUTE_PATH_RE, "<ABS_PATH>");
}

function normalizeLocation(location: string): string {
	return location.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function locationRoot(skill: RawCorpusSkill): string {
	const location = normalizeLocation(skill.location.trim());
	const conventionalSuffix = `/${skill.name}/SKILL.md`;
	if (location.endsWith(conventionalSuffix)) return location.slice(0, -conventionalSuffix.length) || "<RELATIVE_ROOT>";
	const slash = location.lastIndexOf("/");
	return slash > 0 ? location.slice(0, slash) : "<RELATIVE_ROOT>";
}

/** Sanitize a catalog while retaining skill names and deterministic root relationships. */
export function sanitizeCatalogSkills(skills: readonly RawCorpusSkill[]): CorpusSkillV1[] {
	const roots = [...new Set(skills.map(locationRoot))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	const rootNames = new Map(roots.map((root, index) => [root, `<ROOT_${index + 1}>`] as const));
	return skills.map((skill) => {
		const name = redactSensitiveText(skill.name);
		return {
			name,
			description: redactSensitiveText(skill.description),
			location: `${rootNames.get(locationRoot(skill))}/${name}/SKILL.md`,
		};
	});
}

export function createCatalogExampleV1(input: RawCatalogExampleV1, salt: string): CatalogExampleV1 {
	return {
		id: stableCorpusId(salt, "catalog", input),
		label: redactSensitiveText(input.label),
		skills: sanitizeCatalogSkills(input.skills),
	};
}

export function createSkillExampleV1(input: RawSkillExampleV1, salt: string): SkillExampleV1 {
	return {
		id: stableCorpusId(salt, "skill", input),
		label: redactSensitiveText(input.label),
		catalogId: input.catalogId,
		query: redactSensitiveText(input.query),
		relevantSkillNames: input.relevantSkillNames.map(redactSensitiveText),
	};
}

export function createOutputExampleV1(input: RawOutputExampleV1, salt: string): OutputExampleV1 {
	return {
		id: stableCorpusId(salt, "output", input),
		label: redactSensitiveText(input.label),
		tool: redactSensitiveText(input.tool),
		text: redactSensitiveText(input.text),
		evidence: input.evidence.map(redactSensitiveText),
	};
}

export function createPrivateCorpusV1(
	catalogs: readonly CatalogExampleV1[],
	skillExamples: readonly SkillExampleV1[],
	outputExamples: readonly OutputExampleV1[],
): PrivateCorpusV1 {
	return {
		schemaVersion: CORPUS_SCHEMA_VERSION,
		catalogs: [...catalogs],
		skillExamples: [...skillExamples],
		outputExamples: [...outputExamples],
	};
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderAvailableSkills(skills: readonly CorpusSkillV1[]): string {
	const lines = ["<available_skills>"];
	for (const skill of skills) {
		lines.push(
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.location)}</location>`,
			"  </skill>",
		);
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function lineCounts(lines: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

/** Exact evidence recall. Duplicate expected lines require duplicate occurrences. */
export function evidenceRecall(expected: readonly string[], actual: string | readonly string[]): EvidenceRecallResult {
	const lines = typeof actual === "string" ? actual.split(/\r?\n/) : actual;
	const available = lineCounts(lines);
	const missing: string[] = [];
	let matched = 0;
	for (const line of expected) {
		const count = available.get(line) ?? 0;
		if (count === 0) {
			missing.push(line);
			continue;
		}
		available.set(line, count - 1);
		matched++;
	}
	const total = expected.length;
	return {
		expected: total,
		matched,
		recall: total === 0 ? 1 : matched / total,
		missing,
		complete: missing.length === 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafe(value: string): boolean {
	return redactSensitiveText(value) === value;
}

/** Validate schema, referential integrity, privacy, labels and evidence recall. */
export function validateCorpusV1(value: unknown): CorpusValidationResult {
	const issues: CorpusValidationIssue[] = [];
	const issue = (code: CorpusValidationCode, path: string, message: string) => issues.push({ code, path, message });
	if (!isRecord(value)) return { valid: false, issues: [{ code: "invalid-shape", path: "$", message: "corpus must be an object" }] };
	if (value.schemaVersion !== CORPUS_SCHEMA_VERSION) issue("invalid-schema-version", "$.schemaVersion", "schemaVersion must be 1");

	const catalogs = Array.isArray(value.catalogs) ? value.catalogs : [];
	const skillExamples = Array.isArray(value.skillExamples) ? value.skillExamples : [];
	const outputExamples = Array.isArray(value.outputExamples) ? value.outputExamples : [];
	if (!Array.isArray(value.catalogs)) issue("invalid-shape", "$.catalogs", "catalogs must be an array");
	if (!Array.isArray(value.skillExamples)) issue("invalid-shape", "$.skillExamples", "skillExamples must be an array");
	if (!Array.isArray(value.outputExamples)) issue("invalid-shape", "$.outputExamples", "outputExamples must be an array");

	const seenIds = new Set<string>();
	const catalogSkills = new Map<string, Set<string>>();
	const checkExample = (example: Record<string, unknown>, path: string): string | undefined => {
		const id = typeof example.id === "string" ? example.id.trim() : "";
		if (!id) issue("missing-id", `${path}.id`, "example id is required");
		else if (seenIds.has(id)) issue("duplicate-id", `${path}.id`, `duplicate example id: ${id}`);
		else seenIds.add(id);
		const label = typeof example.label === "string" ? example.label : "";
		if (!label.trim()) issue("missing-label", `${path}.label`, "non-empty label is required");
		else if (!isSafe(label)) issue("unsafe-content", `${path}.label`, "label contains raw PII or secret material");
		return id || undefined;
	};
	const checkSafeString = (field: unknown, path: string): field is string => {
		if (typeof field !== "string") {
			issue("invalid-shape", path, "value must be a string");
			return false;
		}
		if (!isSafe(field)) issue("unsafe-content", path, "value contains raw PII or secret material");
		return true;
	};

	catalogs.forEach((raw, catalogIndex) => {
		const path = `$.catalogs[${catalogIndex}]`;
		if (!isRecord(raw)) {
			issue("invalid-shape", path, "catalog example must be an object");
			return;
		}
		const id = checkExample(raw, path);
		const skills = Array.isArray(raw.skills) ? raw.skills : [];
		if (!Array.isArray(raw.skills)) issue("invalid-shape", `${path}.skills`, "skills must be an array");
		const names = new Set<string>();
		skills.forEach((rawSkill, skillIndex) => {
			const skillPath = `${path}.skills[${skillIndex}]`;
			if (!isRecord(rawSkill)) {
				issue("invalid-shape", skillPath, "skill must be an object");
				return;
			}
			const name = checkSafeString(rawSkill.name, `${skillPath}.name`) ? rawSkill.name : "";
			checkSafeString(rawSkill.description, `${skillPath}.description`);
			if (name && names.has(name)) issue("duplicate-skill-name", `${skillPath}.name`, `duplicate skill name: ${name}`);
			if (name) names.add(name);
			if (checkSafeString(rawSkill.location, `${skillPath}.location`)) {
				const expected = /^<ROOT_[1-9]\d*>\//.test(rawSkill.location) && rawSkill.location.endsWith(`/${name}/SKILL.md`);
				if (!expected) issue("invalid-location", `${skillPath}.location`, "location must be <ROOT_n>/<name>/SKILL.md");
			}
		});
		if (id) catalogSkills.set(id, names);
	});

	skillExamples.forEach((raw, index) => {
		const path = `$.skillExamples[${index}]`;
		if (!isRecord(raw)) {
			issue("invalid-shape", path, "skill example must be an object");
			return;
		}
		checkExample(raw, path);
		checkSafeString(raw.query, `${path}.query`);
		const catalogId = typeof raw.catalogId === "string" ? raw.catalogId : "";
		const knownNames = catalogSkills.get(catalogId);
		if (!knownNames) issue("missing-catalog-reference", `${path}.catalogId`, `unknown catalog id: ${catalogId}`);
		const relevant = Array.isArray(raw.relevantSkillNames) ? raw.relevantSkillNames : [];
		if (!Array.isArray(raw.relevantSkillNames)) issue("invalid-shape", `${path}.relevantSkillNames`, "relevantSkillNames must be an array");
		relevant.forEach((name, relevantIndex) => {
			const namePath = `${path}.relevantSkillNames[${relevantIndex}]`;
			if (!checkSafeString(name, namePath)) return;
			if (knownNames && !knownNames.has(name)) issue("unknown-relevant-skill", namePath, `skill is not in catalog ${catalogId}: ${name}`);
		});
	});

	outputExamples.forEach((raw, index) => {
		const path = `$.outputExamples[${index}]`;
		if (!isRecord(raw)) {
			issue("invalid-shape", path, "output example must be an object");
			return;
		}
		checkExample(raw, path);
		checkSafeString(raw.tool, `${path}.tool`);
		const text = checkSafeString(raw.text, `${path}.text`) ? raw.text : "";
		const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
		if (!Array.isArray(raw.evidence)) issue("invalid-shape", `${path}.evidence`, "evidence must be an array");
		const safeEvidence = evidence.filter((entry, evidenceIndex): entry is string => checkSafeString(entry, `${path}.evidence[${evidenceIndex}]`));
		const recall = evidenceRecall(safeEvidence, text);
		if (!recall.complete) issue("missing-evidence", `${path}.evidence`, `${recall.missing.length} evidence occurrence(s) are absent from text`);
	});

	return { valid: issues.length === 0, issues };
}

export function assertValidCorpusV1(value: unknown): asserts value is PrivateCorpusV1 {
	const result = validateCorpusV1(value);
	if (!result.valid) {
		throw new Error(`invalid private corpus:\n${result.issues.map((entry) => `${entry.path} [${entry.code}] ${entry.message}`).join("\n")}`);
	}
}
