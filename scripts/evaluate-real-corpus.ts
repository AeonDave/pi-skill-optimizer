/** Real paired benchmark for off/compact/hybrid and raw/smart/extract/RTK. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	assertValidCorpusV1,
	evidenceRecall,
	renderAvailableSkills,
	type PrivateCorpusV1,
} from "../src/corpus.ts";
import {
	aggregateEvaluationCases,
	evaluateCase,
	parseStrictAllowedSelection,
	type EvaluationCaseResult,
	type EvaluationMode,
} from "../src/evaluation.ts";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";
import { buildExtractPrompt, reduceOutput, utf8ByteLength, validateExtractedOutput } from "../src/output.ts";
import { normalizeProfile, type SkillOptimizerProfile } from "../src/profile.ts";
import { runLuna, type LunaResult } from "./lib/luna.ts";

interface RuntimeSnapshot {
	profile: SkillOptimizerProfile;
	pinnedSkills: string[];
	config: OptimizeConfig;
}

interface ModelArtifact {
	selected: string[];
	result: LunaResult;
	source: ModelResultSource;
}

type ModelResultSource = "fresh-provider" | "resume-cache";

interface ModelCallResult {
	result: LunaResult;
	source: ModelResultSource;
}

interface OptimizeArtifact {
	mode: EvaluationMode;
	renderedText: string;
	renderedSerialized: string;
	selected: string[];
	identity: boolean;
	reoptimizedText: string;
	reoptimizedIdentity: boolean;
	model: ModelArtifact;
}

interface CachedModelResults {
	version: 2;
	results: Record<string, LunaResult>;
}

const DEFAULT_DIR = resolve(".pi", "skill-optimizer", "benchmark");
const MODEL = "openai-codex/gpt-5.6-luna";
const TOKEN_SCOPE = `${MODEL}:anonymized-corpus-evaluator-input`;
const MODEL_CACHE_REVISION = "real-evaluator-v2";
const MODEL_THINKING = "off" as const;
const MODES: readonly EvaluationMode[] = ["off", "compact", "hybrid"];
const SMART_OPTIONS = {
	maxLines: 80,
	maxBytes: 8_000,
	headLines: 20,
	tailLines: 30,
	maxLineBytes: 1_000,
	contextLines: 1,
	minSavingsBytes: 512,
	minSavingsRatio: 0.1,
};

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function atomicJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
}

function positiveIntArg(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} requires a positive integer`);
	return value;
}

function systemText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const system = (payload as { system?: unknown }).system;
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return system.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("\n");
	return "";
}

function cacheKey(systemPrompt: string, userPrompt: string): string {
	return createHash("sha256").update(`${MODEL_CACHE_REVISION}\0${MODEL}\0${MODEL_THINKING}\0${systemPrompt}\0${userPrompt}`, "utf8").digest("hex");
}

function loadCache(path: string): CachedModelResults {
	if (!existsSync(path)) return { version: 2, results: {} };
	try {
		const value = readJson<CachedModelResults>(path);
		return value.version === 2 && value.results && typeof value.results === "object" ? value : { version: 2, results: {} };
	} catch {
		return { version: 2, results: {} };
	}
}

function average(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageOrNull(values: readonly number[]): number | null {
	return values.length === 0 ? null : average(values);
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function rtkFilter(tool: string): string | undefined {
	return tool.match(/^rtk-filter=([^;]+);/)?.[1];
}

function applyRtk(text: string, filter: string): { text: string; available: boolean; error?: string } {
	const result = spawnSync("rtk", ["pipe", "--filter", filter], {
		input: text,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status === 0) return { text: result.stdout, available: true };
	return { text, available: false, error: String(result.stderr || `exit ${result.status}`).trim().slice(0, 500) };
}

function rtkVersion(): string {
	const result = spawnSync("rtk", ["--version"], { encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function exactLinePatterns(lines: readonly string[]): RegExp[] {
	return lines.map((line) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

async function main(): Promise<void> {
	const directoryArg = process.argv.find((arg) => arg.startsWith("--dir="));
	const directory = directoryArg ? resolve(directoryArg.slice(6)) : DEFAULT_DIR;
	const skillLimit = positiveIntArg("--skill-cases", 8);
	const outputLimit = positiveIntArg("--output-cases", 3);
	const resumeModelCache = process.argv.includes("--resume-model-cache");
	const corpus = readJson<PrivateCorpusV1>(join(directory, "corpus.json"));
	assertValidCorpusV1(corpus);
	const runtime = readJson<RuntimeSnapshot>(join(directory, "runtime.json"));
	runtime.profile = normalizeProfile(runtime.profile);

	const cachePath = join(directory, "model-cache.json");
	const cache = resumeModelCache ? loadCache(cachePath) : { version: 2 as const, results: {} };
	let freshProviderCalls = 0;
	let resumeCacheHits = 0;
	let invalidJudgeRetries = 0;
	const callModel = async (systemPrompt: string, userPrompt: string, bypassResume = false): Promise<ModelCallResult> => {
		const key = cacheKey(systemPrompt, userPrompt);
		const found = resumeModelCache && !bypassResume ? cache.results[key] : undefined;
		if (found) {
			resumeCacheHits++;
			return { result: found, source: "resume-cache" };
		}
		freshProviderCalls++;
		process.stderr.write(`Luna call ${freshProviderCalls}: ${Math.round(utf8ByteLength(systemPrompt + userPrompt) / 1024)} KiB prompt\n`);
		const result = await runLuna({ systemPrompt, userPrompt, thinking: MODEL_THINKING, timeoutMs: 600_000, cwd: process.cwd() });
		if (resumeModelCache) {
			cache.results[key] = result;
			atomicJson(cachePath, cache);
		}
		return { result, source: "fresh-provider" };
	};
	const callParsedModel = async <T>(
		systemPrompt: string,
		userPrompt: string,
		label: string,
		parse: (text: string) => T,
	): Promise<{ value: T; call: ModelCallResult }> => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const call = await callModel(systemPrompt, userPrompt, attempt > 0);
			try {
				return { value: parse(call.result.text), call };
			} catch (error) {
				lastError = error;
				invalidJudgeRetries++;
				if (resumeModelCache) {
					delete cache.results[cacheKey(systemPrompt, userPrompt)];
					atomicJson(cachePath, cache);
				}
			}
		}
		throw new Error(`${label} returned invalid JSON twice: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
	};

	const catalog = corpus.catalogs[0];
	if (!catalog) throw new Error("corpus contains no catalog");
	const allowedNames = new Set(catalog.skills.map((skill) => skill.name));
	const originalText = renderAvailableSkills(catalog.skills);
	const cases = corpus.skillExamples.slice(0, skillLimit);
	if (cases.length === 0) throw new Error("corpus contains no observed skill examples");
	const artifacts = new Map<string, Map<EvaluationMode, OptimizeArtifact>>();
	const selectionInstruction = [
		"You are evaluating skill discovery against an anonymized real catalog.",
		"Choose every skill that should be loaded at any stage to complete TASK, including workflow and verification support. Use exact catalog names and avoid irrelevant skills.",
		"Return only JSON in this form: {\"skills\":[\"name\"]}. Use an empty array when none applies.",
	].join("\n");

	for (const mode of MODES) {
		for (let index = 0; index < cases.length; index++) {
			const example = cases[index];
			const payload = { system: originalText, messages: [{ role: "user", content: example.query }] };
			const config: OptimizeConfig = {
				...runtime.config,
				mode,
				toolsMode: "off",
				profile: runtime.profile,
				pinnedSkills: runtime.pinnedSkills,
			};
			const first = optimize(payload, config);
			const renderedText = systemText(first.next);
			const second = optimize(first.next, config);
			const reoptimizedText = systemText(second.next);
			const systemPrompt = `${selectionInstruction}\n\n${renderedText}`;
			const userPrompt = `TASK:\n${example.query}`;
			const parsedModel = await callParsedModel(
				systemPrompt,
				userPrompt,
				`skill selection for ${example.id}/${mode}`,
				(text) => parseStrictAllowedSelection(text, "skills", allowedNames),
			);
			const modes = artifacts.get(example.id) ?? new Map<EvaluationMode, OptimizeArtifact>();
			modes.set(mode, {
				mode,
				renderedText,
				renderedSerialized: JSON.stringify(first.next),
				selected: first.selected,
				identity: first.next === payload,
				reoptimizedText,
				reoptimizedIdentity: second.next === first.next,
				model: { selected: parsedModel.value, result: parsedModel.call.result, source: parsedModel.call.source },
			});
			artifacts.set(example.id, modes);
		}
	}

	const evaluatedCases: EvaluationCaseResult[] = cases.map((example) => {
		const modes = artifacts.get(example.id)!;
		const baselineArtifact = modes.get("off")!;
		return evaluateCase({
			id: example.id,
			catalogKey: catalog.id,
			originalText,
			originalSerializedText: JSON.stringify({ system: originalText, messages: [{ role: "user", content: example.query }] }),
			requiredGroups: example.relevantSkillNames.map((name) => ({ anyOf: [name] })),
			modes: MODES.map((mode) => {
				const artifact = modes.get(mode)!;
				const exactTokenCounts = baselineArtifact.model.source === "fresh-provider" && artifact.model.source === "fresh-provider"
					? { tokenizer: TOKEN_SCOPE, before: baselineArtifact.model.result.usage.inputTokens, after: artifact.model.result.usage.inputTokens }
					: undefined;
				return {
					mode,
					renderedText: artifact.renderedText,
					renderedSerializedText: artifact.renderedSerialized,
					selectedSkillNames: artifact.selected,
					modelSelectedSkillNames: artifact.model.selected,
					identityPreserved: artifact.identity,
					reoptimizedText: artifact.reoptimizedText,
					reoptimizedIdentity: artifact.reoptimizedIdentity,
					...(exactTokenCounts ? { exactTokenCounts } : {}),
				};
			}),
		});
	});
	const skillAggregate = aggregateEvaluationCases(evaluatedCases);

	const skillModeSummary = Object.fromEntries(MODES.map((mode) => {
		const modeArtifacts = cases.map((example) => artifacts.get(example.id)!.get(mode)!);
		const freshArtifacts = modeArtifacts.filter((artifact) => artifact.model.source === "fresh-provider");
		return [mode, {
			freshProviderSamples: freshArtifacts.length,
			resumeCacheSamples: modeArtifacts.length - freshArtifacts.length,
			anonymizedCorpusInputTokensMean: averageOrNull(freshArtifacts.map((artifact) => artifact.model.result.usage.inputTokens)),
			currentRunCacheReadTokensMean: averageOrNull(freshArtifacts.map((artifact) => artifact.model.result.usage.cacheReadTokens)),
			currentRunCacheWriteTokensMean: averageOrNull(freshArtifacts.map((artifact) => artifact.model.result.usage.cacheWriteTokens)),
			currentRunOutputTokensMean: averageOrNull(freshArtifacts.map((artifact) => artifact.model.result.usage.outputTokens)),
			modelRecall: skillAggregate.modes[mode].modelSelectedRecall,
			modelAnyHitRate: average(cases.map((example) => example.relevantSkillNames.some((name) => artifacts.get(example.id)!.get(mode)!.model.selected.includes(name)) ? 1 : 0)),
			fullExposureRecall: skillAggregate.modes[mode].fullRecall,
			intentExposureRecall: skillAggregate.modes[mode].intentRecall,
			anonymizedCorpusBytesAfterMean: skillAggregate.modes[mode].bytesAfter.mean,
		}];
	}));

	const outputReports = [];
	for (const example of corpus.outputExamples.slice(0, outputLimit)) {
		const filter = rtkFilter(example.tool);
		const protectedPatterns = exactLinePatterns(example.evidence);
		const smart = reduceOutput(example.text, { ...SMART_OPTIONS, patterns: protectedPatterns });
		const prompt = buildExtractPrompt("Retain task-relevant facts and all diagnostics.", example.tool, example.text);
		const extractedModel = await callModel(prompt.system, prompt.user);
		const extracted = validateExtractedOutput(example.text, extractedModel.result.text, {
			smartOptions: { ...SMART_OPTIONS, patterns: protectedPatterns },
			protectedPatterns,
			minSavingsBytes: SMART_OPTIONS.minSavingsBytes,
			minSavingsRatio: SMART_OPTIONS.minSavingsRatio,
		});
		const rtk = filter ? applyRtk(example.text, filter) : { text: example.text, available: false, error: "missing filter" };
		const variants = {
			raw: { text: example.text, available: true },
			smart: { text: smart.text, available: true },
			extract: { text: extracted.text, available: true },
			rtk,
		};
		const measured: Record<string, unknown> = {};
		for (const [name, variant] of Object.entries(variants)) {
			if (!variant.available) {
				measured[name] = { available: false, error: "error" in variant ? variant.error : "unavailable" };
				continue;
			}
			const evidenceIds = example.evidence.map((_line, index) => `E${index + 1}`);
			const allowedEvidenceIds = new Set(evidenceIds);
			const evidenceReference = example.evidence.map((line, index) => `${evidenceIds[index]}: ${line}`).join("\n");
			const judged = await callParsedModel(
				[
					"Judge whether each REFERENCE FACT remains recoverable from CANDIDATE OUTPUT.",
					"Count a fact only when the same concrete information is present; do not infer omitted details.",
					"Return only JSON: {\"recoverable\":[\"E1\"]} using the supplied fact IDs.",
				].join("\n"),
				`REFERENCE FACTS:\n${evidenceReference || "(none)"}\n\nCANDIDATE OUTPUT:\n${variant.text}`,
				`output evidence judge for ${example.id}/${name}`,
				(text) => parseStrictAllowedSelection(text, "recoverable", allowedEvidenceIds),
			);
			const evidence = evidenceRecall(example.evidence, variant.text);
			const recovered = judged.value;
			measured[name] = {
				available: true,
				bytes: utf8ByteLength(variant.text),
				bytesSaved: utf8ByteLength(example.text) - utf8ByteLength(variant.text),
				evidenceRecall: evidence.recall,
				evidenceComplete: evidence.complete,
				semanticEvidenceRecall: evidenceIds.length === 0 ? 1 : recovered.length / evidenceIds.length,
				judgeResultSource: judged.call.source,
				actualFixedJudgeInputTokens: judged.call.source === "fresh-provider" ? judged.call.result.usage.inputTokens : null,
				currentRunJudgeCacheReadTokens: judged.call.source === "fresh-provider" ? judged.call.result.usage.cacheReadTokens : null,
			};
		}
		outputReports.push({
			id: example.id,
			label: example.label,
			filter,
			extractStrategy: extracted.strategy,
			extractRejectionReason: extracted.rejectionReason,
			variants: measured,
		});
	}

	const caseSummaries = evaluatedCases.map((entry) => ({
		id: entry.id,
		expectedSkillNames: cases.find((example) => example.id === entry.id)?.relevantSkillNames ?? [],
		modes: Object.fromEntries(MODES.map((mode) => [mode, {
			promoted: artifacts.get(entry.id)!.get(mode)!.selected,
			modelSelected: artifacts.get(entry.id)!.get(mode)!.model.selected,
			fullRecall: entry.modes[mode].coverage.full.recall,
			modelRecall: entry.modes[mode].coverage.modelSelected?.recall ?? null,
			bytesAfter: entry.modes[mode].bytesAfter,
			inputTokens: entry.modes[mode].exactTokenCounts?.after,
			cacheReadTokens: artifacts.get(entry.id)!.get(mode)!.model.result.usage.cacheReadTokens,
			safetyPassed: entry.modes[mode].safety.passed,
		}])),
	}));
	const projectOutputSafetyPassed = outputReports.every((entry) => ["smart", "extract"].every((name) => {
		const variant = entry.variants[name] as { evidenceComplete?: boolean };
		return variant.evidenceComplete !== false;
	}));
	const rtkSafetyMeasurements = outputReports
		.map((entry) => entry.variants.rtk as { available?: boolean; evidenceComplete?: boolean; semanticEvidenceRecall?: number })
		.filter((variant) => variant.available);
	const rtkExternalSafetyPassed = rtkSafetyMeasurements.length === 0
		? null
		: rtkSafetyMeasurements.every((variant) => variant.evidenceComplete === true && variant.semanticEvidenceRecall === 1);
	const projectSafetyPassed = skillAggregate.hardSafetyPassed && projectOutputSafetyPassed;
	const report = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		model: `${MODEL}:${MODEL_THINKING}`,
		rtkVersion: rtkVersion(),
		measurementScope: {
			tokens: "actual provider usage for fresh anonymized-corpus evaluator requests; not production payload token counts",
			outputJudgeTokens: "actual full fixed-judge-input tokens, including instructions and reference facts; not candidate-only tokens",
			bytes: "UTF-8 bytes of the anonymized corpus artifacts",
		},
		corpus: { catalogId: catalog.id, skills: catalog.skills.length, skillCases: cases.length, outputCases: outputReports.length },
		modelExecution: { resumeEnabled: resumeModelCache, freshProviderCalls, resumeCacheHits, invalidJudgeRetries },
		skillModeSummary,
		skillAggregate,
		skillCases: caseSummaries,
		outputCases: outputReports,
		projectSafety: { passed: projectSafetyPassed, skillSafetyPassed: skillAggregate.hardSafetyPassed, outputSafetyPassed: projectOutputSafetyPassed },
		rtkExternalSafety: { passed: rtkExternalSafetyPassed, evaluatedCases: rtkSafetyMeasurements.length },
	};
	atomicJson(join(directory, "real-report.json"), report);

	console.log(`\nreal skill benchmark: ${cases.length} observed cases, ${catalog.skills.length} catalog skills`);
	console.log("mode     | anon input tok | fresh/cache | model recall | any hit | full exposure | anon bytes");
	console.log("---------|----------------|-------------|--------------|---------|---------------|-----------");
	for (const mode of MODES) {
		const summary = skillModeSummary[mode] as typeof skillModeSummary[string];
		const inputTokens = summary.anonymizedCorpusInputTokensMean === null ? "n/a" : Math.round(summary.anonymizedCorpusInputTokensMean).toString();
		console.log(`${mode.padEnd(8)} | ${inputTokens.padStart(14)} | ${`${summary.freshProviderSamples}/${summary.resumeCacheSamples}`.padStart(11)} | ${percent(summary.modelRecall.microRecall).padStart(12)} | ${percent(summary.modelAnyHitRate).padStart(7)} | ${percent(summary.fullExposureRecall.microRecall).padStart(13)} | ${Math.round(summary.anonymizedCorpusBytesAfterMean ?? 0).toString().padStart(9)}`);
	}
	console.log(`\nreal output benchmark: ${outputReports.length} cases; RTK ${report.rtkVersion}`);
	for (const entry of outputReports) {
		const variants = entry.variants as Record<string, { available: boolean; bytes?: number; actualFixedJudgeInputTokens?: number | null; evidenceRecall?: number; semanticEvidenceRecall?: number }>;
		console.log(`${entry.label}: ${Object.entries(variants).map(([name, value]) => value.available ? `${name}=${value.bytes}B/judge-input ${value.actualFixedJudgeInputTokens ?? "resume"}tok/exact ${percent(value.evidenceRecall ?? null)}/semantic ${percent(value.semanticEvidenceRecall ?? null)}` : `${name}=n/a`).join(" | ")}`);
	}
	console.log(`\nfresh Luna calls: ${freshProviderCalls}; resume-cache hits: ${resumeCacheHits}; invalid-judge retries: ${invalidJudgeRetries}`);
	console.log(`project safety: ${projectSafetyPassed ? "PASS" : "FAIL"}; RTK external safety: ${rtkExternalSafetyPassed === null ? "N/A" : rtkExternalSafetyPassed ? "PASS" : "FAIL"}`);
	console.log(`report: ${join(directory, "real-report.json")}`);
	if (!projectSafetyPassed) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
