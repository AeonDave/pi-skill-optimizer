import { performance } from "node:perf_hooks";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { normalizeRequest } from "../src/request.ts";
import { optimizePayload } from "../src/optimize.ts";
import { collectSkillUsageEvidence } from "../src/usage.ts";

function catalog(count: number): string {
	const entries = Array.from({ length: count }, (_, index) => [
		"<skill>",
		`<name>skill-${index}</name>`,
		`<description>Workflow ${index} for ${index % 17 === 0 ? "incident response logs" : "deterministic engineering support"}. ${"Detailed routing and verification guidance. ".repeat(3)}</description>`,
		`<location>/synthetic/skill-${index}/SKILL.md</location>`,
		"</skill>",
	].join("\n"));
	return `<available_skills>\n${entries.join("\n")}\n</available_skills>`;
}

function payload(skillCount: number): unknown {
	const messages = Array.from({ length: 200 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: `historical message ${index} with bounded ordinary context`,
	}));
	messages.push({ role: "user", content: "triage an incident from logs" });
	return { system: catalog(skillCount), messages };
}

function measure(skillCount: number, iterations: number): void {
	const request = payload(skillCount);
	const startCold = performance.now();
	const cold = optimizePayload(request, DEFAULT_CONFIG);
	const coldMs = performance.now() - startCold;
	if (cold.removedChars <= 0 || cold.catalogNames.length !== skillCount) {
		throw new Error(`performance fixture failed for ${skillCount} skills`);
	}
	const samples: number[] = [];
	for (let index = 0; index < iterations; index += 1) {
		const start = performance.now();
		const result = optimizePayload(request, DEFAULT_CONFIG);
		samples.push(performance.now() - start);
		if (result.removedChars !== cold.removedChars) throw new Error("non-deterministic optimized size");
	}
	const steadyMs = samples.reduce((total, value) => total + value, 0) / samples.length;
	samples.sort((left, right) => left - right);
	const percentile = (fraction: number): number => samples[Math.ceil(samples.length * fraction) - 1];
	console.log(`${skillCount} skills | cold ${coldMs.toFixed(2)} ms | steady ${steadyMs.toFixed(2)} ms | p50 ${percentile(0.5).toFixed(2)} ms | p95 ${percentile(0.95).toFixed(2)} ms | n=${iterations} | removed ${cold.removedChars} chars`);
}

console.log(`Synthetic request latency | ${process.platform}/${process.arch} | Node ${process.version} | not UI/model latency`);
measure(284, 30);
measure(2_000, 30);

/**
 * Usage evidence runs on every provider request over the whole selected skill
 * list, so its hot path is a latency gate, not only a correctness concern.
 * The fixture pins 200 human messages against 500 skills; the pre-fix shape
 * rebuilt one RegExp per (message, skill) pair and measured tens of ms.
 */
const USAGE_SKILL_COUNT = 500;
const USAGE_MESSAGE_COUNT = 200;
const USAGE_ITERATIONS = 10;
const USAGE_MAX_MS_PER_CALL = 25;

function usageSkills(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `skill-${index}`);
}

function usageRequest(skillCount: number, messageCount: number): { payload: unknown; expected: number } {
	const messages = Array.from({ length: messageCount }, (_, index) => ({
		id: `message-${index}`,
		role: "user",
		content: `historical message ${index} about deterministic engineering support, verification, and bounded reading budgets`,
	}));
	let expected = 0;
	for (let index = 0; index < messages.length; index += 25) {
		messages[index].content += ` /skill:skill-${index % skillCount}`;
		expected += 1;
	}
	return { payload: { messages }, expected };
}

/** Timing-only reference of the pre-fix shape: one fresh RegExp per pair. */
function legacyEvidence(payload: unknown, skills: readonly string[]): number {
	const messages = normalizeRequest(payload).messages;
	const selected = skills.map((name) => name.toLowerCase());
	let found = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = message.text.toLowerCase();
		if (!text) continue;
		for (const lower of selected) {
			const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(^|[^a-z0-9:_-])(?:/skill:|/)?${escaped}($|[^a-z0-9:_-])`).test(text)) found++;
		}
	}
	return found;
}

function measureUsageEvidence(): void {
	const skills = usageSkills(USAGE_SKILL_COUNT);
	const { payload, expected } = usageRequest(USAGE_SKILL_COUNT, USAGE_MESSAGE_COUNT);
	const startNaive = performance.now();
	const naiveFound = legacyEvidence(payload, skills);
	const naiveMs = performance.now() - startNaive;

	const first = collectSkillUsageEvidence(payload, skills);
	if (first.length !== expected) throw new Error(`usage fixture expected ${expected} evidence entries, got ${first.length}`);
	const start = performance.now();
	for (let iteration = 0; iteration < USAGE_ITERATIONS; iteration++) {
		const evidence = collectSkillUsageEvidence(payload, skills);
		if (evidence.length !== expected) throw new Error("non-deterministic usage evidence count");
	}
	const perCallMs = (performance.now() - start) / USAGE_ITERATIONS;
	if (naiveFound !== expected) throw new Error(`legacy fixture expected ${expected} matches, got ${naiveFound}`);
	const speedup = (naiveMs / Math.max(perCallMs, 1e-6)).toFixed(1);
	console.log(`usage evidence | ${skills.length} skills x ${USAGE_MESSAGE_COUNT} user messages | ${perCallMs.toFixed(2)} ms/call | naive pair-regex ${naiveMs.toFixed(2)} ms | ${speedup}x | n=${USAGE_ITERATIONS}`);
	if (perCallMs > USAGE_MAX_MS_PER_CALL) {
		throw new Error(`usage evidence ${perCallMs.toFixed(2)} ms/call exceeds ${USAGE_MAX_MS_PER_CALL} ms budget`);
	}
}

measureUsageEvidence();
