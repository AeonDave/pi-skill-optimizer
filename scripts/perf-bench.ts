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
	const startSteady = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		const result = optimizePayload(request, DEFAULT_CONFIG);
		if (result.removedChars !== cold.removedChars) throw new Error("non-deterministic optimized size");
	}
	const steadyMs = (performance.now() - startSteady) / iterations;
	console.log(`${skillCount} skills | cold ${coldMs.toFixed(2)} ms | steady ${steadyMs.toFixed(2)} ms | removed ${cold.removedChars} chars`);
}

measure(284, 10);
measure(2_000, 5);
