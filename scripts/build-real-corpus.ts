/**
 * Capture the real Pi skill catalog, then build a private anonymized corpus from
 * observed user turns, real SKILL.md reads, and real shell outputs.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	assertValidCorpusV1,
	createOutputExampleV1,
	createPrivateCorpusV1,
	createSkillExampleV1,
	redactSensitiveText,
	type CatalogExampleV1,
	type OutputExampleV1,
	type SkillExampleV1,
} from "../src/corpus.ts";
import { getConfig, getPinnedTopK, getProfilePaths, getUsageFilePath } from "../src/config.ts";
import { collectIndependentEvidenceLines } from "../src/evaluation.ts";
import { truncateUtf8Bytes, utf8ByteLength } from "../src/output.ts";
import { loadMergedProfile, loadUsageFile } from "../src/persistence.ts";
import { selectPinnedSkills } from "../src/usage.ts";
import { parsePiJsonl } from "./lib/luna.ts";

type JsonRecord = Record<string, unknown>;

interface SessionEntry extends JsonRecord {
	id?: string;
	parentId?: string;
	timestamp?: string;
	message?: JsonRecord;
}

interface ToolCall {
	entry: SessionEntry;
	id: string;
	name: string;
	arguments: JsonRecord;
}

interface SkillCandidate {
	query: string;
	relevantSkillNames: string[];
	timestamp: number;
}

interface OutputCandidate {
	command: string;
	filter: string;
	text: string;
	evidence: string[];
	timestamp: number;
}

const DEFAULT_DIR = join(process.cwd(), ".pi", "skill-optimizer", "benchmark");
const MAX_SESSION_FILES = 120;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_OUTPUT_BYTES = 4 * 1024;
const MAX_SKILL_EXAMPLES = 24;
const MAX_OUTPUT_EXAMPLES = 6;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atomicJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	if (process.platform !== "win32") chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

function ensureSalt(path: string): string {
	if (existsSync(path)) {
		const value = readFileSync(path, "utf8").trim();
		if (value.length < 16) throw new Error(`invalid corpus salt at ${path}`);
		return value;
	}
	mkdirSync(dirname(path), { recursive: true });
	const value = randomBytes(32).toString("hex");
	writeFileSync(path, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600);
	return value;
}

function safeDiagnostic(value: string): string {
	return redactSensitiveText(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).trim().slice(0, 1_500);
}

function captureCatalog(outputPath: string, salt: string): { usage: ReturnType<typeof parsePiJsonl>["usage"] } {
	const extension = resolve("scripts", "capture-catalog-extension.ts");
	const result = spawnSync("rtk", [
		"proxy", "pi", "--offline", "--approve",
		"--model", "openai-codex/gpt-5.6-luna:low",
		"--mode", "json", "--print", "--no-session",
		"--no-extensions", "-e", extension, "--no-context-files",
		"Reply exactly OK.",
	], {
		cwd: process.cwd(),
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
		env: {
			...process.env,
			PI_SKILL_OPTIMIZER_CORPUS_CAPTURE: outputPath,
			PI_SKILL_OPTIMIZER_CORPUS_SALT: salt,
		},
	});
	if (result.status !== 0) throw new Error(`Pi catalog capture failed: ${safeDiagnostic(result.stderr || result.stdout)}`);
	if (!existsSync(outputPath)) throw new Error("Pi completed without producing a catalog snapshot");
	return { usage: parsePiJsonl(result.stdout).usage };
}

function collectSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: Array<{ path: string; mtime: number; size: number }> = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const stat = statSync(path);
				files.push({ path, mtime: stat.mtimeMs, size: stat.size });
			}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const selected: string[] = [];
	let bytes = 0;
	for (const file of files) {
		if (selected.length >= MAX_SESSION_FILES || bytes + file.size > MAX_SESSION_BYTES) break;
		selected.push(file.path);
		bytes += file.size;
	}
	return selected;
}

function parseEntries(path: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (isRecord(value)) entries.push(value as SessionEntry);
		} catch {
			// A partial final JSONL line must not invalidate earlier observations.
		}
	}
	return entries;
}

function textContent(message: JsonRecord | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isRecord)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function toolCalls(entries: readonly SessionEntry[]): Map<string, ToolCall> {
	const calls = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content.filter(isRecord)) {
			if (part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
			calls.set(part.id, {
				entry,
				id: part.id,
				name: part.name,
				arguments: isRecord(part.arguments) ? part.arguments : {},
			});
		}
	}
	return calls;
}

function ancestorUser(entry: SessionEntry, byId: ReadonlyMap<string, SessionEntry>): SessionEntry | undefined {
	let parentId = entry.parentId;
	const visited = new Set<string>();
	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return undefined;
		if (parent.message?.role === "user") return parent;
		parentId = parent.parentId;
	}
	return undefined;
}

function skillNameForPath(path: string, catalogNames: readonly string[]): string | undefined {
	if (!/[\\/]SKILL\.md$/i.test(path)) return undefined;
	const directoryName = basename(dirname(path)).toLowerCase();
	const exact = catalogNames.filter((name) => name.toLowerCase() === directoryName);
	if (exact.length === 1) return exact[0];
	const suffix = catalogNames.filter((name) => name.toLowerCase().endsWith(`:${directoryName}`));
	return suffix.length === 1 ? suffix[0] : undefined;
}

function likelyInjectedOrExplicit(query: string): boolean {
	const trimmed = query.trim();
	return !trimmed
		|| /(?:^|\s)\/skill(?::|\s)/i.test(trimmed)
		|| /^<(?:system|system-reminder|available_skills)\b/i.test(trimmed);
}

function filterForCommand(command: string): { command: string; filter: string } | undefined {
	let value = command.trim();
	const raw = value.match(/^rtk\s+run\s+-c\s+["']([\s\S]*)["']\s*$/i);
	if (raw) value = raw[1];
	else if (/^rtk\b/i.test(value)) return undefined;
	if (/(?:^|\s)(?:rg|grep)(?:\s|$)/i.test(value)) return { command: value, filter: "grep" };
	if (/(?:^|\s)pytest(?:\s|$)/i.test(value)) return { command: value, filter: "pytest" };
	if (/\bcargo\s+test\b/i.test(value)) return { command: value, filter: "cargo-test" };
	if (/\bgit\s+log\b/i.test(value)) return { command: value, filter: "git-log" };
	if (/\b(?:npm\s+(?:run\s+)?test|node\b.*--test)\b/i.test(value)) return { command: value, filter: "log" };
	return undefined;
}

function timestamp(entry: SessionEntry): number {
	const value = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number(entry.timestamp);
	return Number.isFinite(value) ? value : 0;
}

function inspectSessions(paths: readonly string[], catalog: CatalogExampleV1): { skills: SkillCandidate[]; outputs: OutputCandidate[] } {
	const skillGroups = new Map<string, SkillCandidate>();
	const outputs: OutputCandidate[] = [];
	const catalogNames = catalog.skills.map((skill) => skill.name);
	for (const path of paths) {
		const entries = parseEntries(path);
		const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry] as const));
		const calls = toolCalls(entries);
		for (const call of calls.values()) {
			if (call.name === "read" && typeof call.arguments.path === "string") {
				const skillName = skillNameForPath(call.arguments.path, catalogNames);
				const user = skillName ? ancestorUser(call.entry, byId) : undefined;
				const query = user ? textContent(user.message) : "";
				if (!skillName || !user?.id || likelyInjectedOrExplicit(query)) continue;
				const key = `${path}\0${user.id}`;
				const current = skillGroups.get(key) ?? { query, relevantSkillNames: [], timestamp: timestamp(user) };
				if (!current.relevantSkillNames.includes(skillName)) current.relevantSkillNames.push(skillName);
				skillGroups.set(key, current);
			}
		}

		for (const entry of entries) {
			if (entry.message?.role !== "toolResult" || typeof entry.message.toolCallId !== "string") continue;
			const call = calls.get(entry.message.toolCallId);
			if (!call || call.name !== "bash" || typeof call.arguments.command !== "string") continue;
			const commandInfo = filterForCommand(call.arguments.command);
			const text = textContent(entry.message);
			const bytes = utf8ByteLength(text);
			if (!commandInfo || bytes < MIN_OUTPUT_BYTES || bytes > MAX_OUTPUT_BYTES || /full output (?:saved|available)/i.test(text)) continue;
			outputs.push({
				...commandInfo,
				text,
				evidence: collectIndependentEvidenceLines(text),
				timestamp: timestamp(entry),
			});
		}
	}
	return { skills: [...skillGroups.values()], outputs };
}

function captureLiveOutputs(): OutputCandidate[] {
	const specs = [
		{ filter: "grep", command: "rg -n 'skill|output|tool' README.md AGENTS.md CHANGELOG.md" },
		{ filter: "log", command: "npm test" },
	];
	return specs.flatMap((spec): OutputCandidate[] => {
		const result = spawnSync("rtk", ["run", "-c", spec.command], {
			cwd: process.cwd(), encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true,
		});
		const text = `${result.stdout ?? ""}${result.stderr ?? ""}\nexit code: ${result.status ?? -1}`;
		if (utf8ByteLength(text) < MIN_OUTPUT_BYTES || utf8ByteLength(text) > MAX_OUTPUT_BYTES) return [];
		return [{ ...spec, text, evidence: collectIndependentEvidenceLines(text), timestamp: Date.now() }];
	});
}

function chooseSkillExamples(candidates: readonly SkillCandidate[]): SkillCandidate[] {
	const sorted = [...candidates].sort((a, b) => b.timestamp - a.timestamp);
	const selected: SkillCandidate[] = [];
	const seenQueries = new Set<string>();
	const seenSkills = new Set<string>();
	for (const candidate of sorted) {
		const query = truncateUtf8Bytes(candidate.query.trim(), 8_000);
		if (!query || seenQueries.has(query) || candidate.relevantSkillNames.every((name) => seenSkills.has(name))) continue;
		selected.push({ ...candidate, query });
		seenQueries.add(query);
		for (const name of candidate.relevantSkillNames) seenSkills.add(name);
		if (selected.length >= MAX_SKILL_EXAMPLES) break;
	}
	for (const candidate of sorted) {
		if (selected.length >= MAX_SKILL_EXAMPLES) break;
		const query = truncateUtf8Bytes(candidate.query.trim(), 8_000);
		if (!query || seenQueries.has(query)) continue;
		selected.push({ ...candidate, query });
		seenQueries.add(query);
	}
	return selected;
}

function chooseOutputExamples(candidates: readonly OutputCandidate[]): OutputCandidate[] {
	const unique = new Map<string, OutputCandidate>();
	for (const candidate of [...candidates].sort((a, b) => b.evidence.length - a.evidence.length || b.timestamp - a.timestamp)) {
		const key = `${candidate.filter}\0${candidate.command}\0${candidate.text}`;
		if (!unique.has(key)) unique.set(key, candidate);
	}
	const selected: OutputCandidate[] = [];
	const seenFilters = new Set<string>();
	for (const candidate of unique.values()) {
		if (seenFilters.has(candidate.filter)) continue;
		selected.push(candidate);
		seenFilters.add(candidate.filter);
	}
	for (const candidate of unique.values()) {
		if (selected.length >= MAX_OUTPUT_EXAMPLES) break;
		if (!selected.includes(candidate)) selected.push(candidate);
	}
	return selected.slice(0, MAX_OUTPUT_EXAMPLES);
}

function sanitizedProfileSnapshot(catalog: CatalogExampleV1) {
	const profile = loadMergedProfile(getProfilePaths(process.cwd()));
	const names = new Set(catalog.skills.map((skill) => skill.name));
	const textMap = (record: Record<string, string[]>) => Object.fromEntries(Object.entries(record)
		.filter(([name]) => names.has(name))
		.map(([name, values]) => [name, values.map(redactSensitiveText)]));
	const aliases = Object.fromEntries(Object.entries(profile.aliases)
		.map(([key, values]) => [redactSensitiveText(key), values.map(redactSensitiveText)]));
	const usage = loadUsageFile(getUsageFilePath(process.cwd()));
	return {
		profile: {
			aliases,
			critical: profile.critical.filter((name) => names.has(name)),
			queries: textMap(profile.queries),
			clusters: textMap(profile.clusters),
			negativeHints: textMap(profile.negativeHints),
		},
		pinnedSkills: selectPinnedSkills(usage, getPinnedTopK(process.cwd()), Date.now()).filter((name) => names.has(name)),
		config: getConfig(process.cwd()),
	};
}

function main(): void {
	const directory = resolve(process.argv[2] || DEFAULT_DIR);
	mkdirSync(directory, { recursive: true });
	const salt = ensureSalt(join(directory, "salt"));
	const capturePath = join(directory, "catalog.json");
	const capture = captureCatalog(capturePath, salt);
	const catalog = JSON.parse(readFileSync(capturePath, "utf8")) as CatalogExampleV1;

	const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
	const sessionFiles = collectSessionFiles(sessionRoot);
	const observed = inspectSessions(sessionFiles, catalog);
	const skillCandidates = chooseSkillExamples(observed.skills);
	const outputCandidates = chooseOutputExamples([...observed.outputs, ...captureLiveOutputs()]);

	const skillExamples: SkillExampleV1[] = skillCandidates.map((candidate) => createSkillExampleV1({
		label: "observed real skill load",
		catalogId: catalog.id,
		query: candidate.query,
		relevantSkillNames: candidate.relevantSkillNames,
	}, salt));
	const outputExamples: OutputExampleV1[] = outputCandidates.map((candidate) => createOutputExampleV1({
		label: `real ${candidate.filter} output`,
		tool: `rtk-filter=${candidate.filter}; command=${candidate.command}`,
		text: candidate.text,
		evidence: candidate.evidence,
	}, salt));
	const corpus = createPrivateCorpusV1([catalog], skillExamples, outputExamples);
	assertValidCorpusV1(corpus);

	atomicJson(join(directory, "corpus.json"), corpus);
	atomicJson(join(directory, "runtime.json"), sanitizedProfileSnapshot(catalog));
	atomicJson(join(directory, "manifest.json"), {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		model: "openai-codex/gpt-5.6-luna:low",
		catalogCaptureUsage: capture.usage,
		catalogSkills: catalog.skills.length,
		sessionFilesInspected: sessionFiles.length,
		observedSkillCandidates: observed.skills.length,
		observedOutputCandidates: observed.outputs.length,
		skillExamples: skillExamples.length,
		outputExamples: outputExamples.length,
	});
	console.log(`real private corpus: ${catalog.skills.length} skills, ${skillExamples.length} observed skill cases, ${outputExamples.length} real outputs`);
	console.log(`written under ${directory}`);
}

main();
