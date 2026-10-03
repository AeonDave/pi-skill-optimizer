import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import captureCatalog from "../scripts/capture-catalog-extension.ts";

test("Pi 1.0 before_agent_start captures and sanitizes the opt-in catalog once", () => {
	const outputPath = join(tmpdir(), `sko-capture-${randomUUID()}.json`);
	const previousPath = process.env.PI_SKILL_OPTIMIZER_CORPUS_CAPTURE;
	const previousSalt = process.env.PI_SKILL_OPTIMIZER_CORPUS_SALT;
	process.env.PI_SKILL_OPTIMIZER_CORPUS_CAPTURE = outputPath;
	process.env.PI_SKILL_OPTIMIZER_CORPUS_SALT = "local-test-salt-only";
	try {
		const handlers = new Map<string, (event: unknown) => void>();
		captureCatalog({
			on(name: string, handler: (event: unknown) => void) {
				handlers.set(name, handler);
				return () => {};
			},
		} as unknown as ExtensionAPI);
		const beforeAgentStart = handlers.get("before_agent_start");
		assert.ok(beforeAgentStart, "capture must use the Pi 1.0 event that exposes skill options");
		beforeAgentStart({ systemPromptOptions: { skills: [{
			name: "fixture-triage",
			description: "Triage a reproducible issue.",
			filePath: "C:\\Users\\private\\skills\\fixture-triage\\SKILL.md",
		}] } });
		assert.equal(existsSync(outputPath), true);
		const saved = JSON.parse(readFileSync(outputPath, "utf8")) as {
			skills: Array<{ name: string; location: string }>;
		};
		assert.equal(saved.skills[0].name, "fixture-triage");
		assert.ok(!JSON.stringify(saved).includes("C:\\Users\\private"), "private source path escaped sanitization");
		beforeAgentStart({ systemPromptOptions: { skills: [{
			name: "different-skill", description: "A later catalog.", filePath: "C:\\private\\SKILL.md",
		}] } });
		assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).skills[0].name, "fixture-triage");
	} finally {
		if (previousPath === undefined) delete process.env.PI_SKILL_OPTIMIZER_CORPUS_CAPTURE;
		else process.env.PI_SKILL_OPTIMIZER_CORPUS_CAPTURE = previousPath;
		if (previousSalt === undefined) delete process.env.PI_SKILL_OPTIMIZER_CORPUS_SALT;
		else process.env.PI_SKILL_OPTIMIZER_CORPUS_SALT = previousSalt;
		if (existsSync(outputPath)) unlinkSync(outputPath);
	}
});
