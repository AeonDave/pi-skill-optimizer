import { performance } from "node:perf_hooks";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { optimizePayload } from "../src/optimize.ts";

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
