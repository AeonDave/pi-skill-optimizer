/** One-shot Pi extension used only by `npm run corpus:build`. */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCatalogExampleV1 } from "../src/corpus.ts";
import { parseSkills } from "../src/skills.ts";

const BLOCK_RE = /<available_skills>([\s\S]*?)<\/available_skills>/g;

function stringsIn(value: unknown, out: string[], seen = new WeakSet<object>()): void {
	if (typeof value === "string") {
		if (value.includes("<available_skills>")) out.push(value);
		return;
	}
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) stringsIn(item, out, seen);
	} else {
		for (const item of Object.values(value as Record<string, unknown>)) stringsIn(item, out, seen);
	}
}

function writePrivateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	if (process.platform !== "win32") chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export default function captureCatalog(pi: ExtensionAPI): void {
	let captured = false;
	const save = (rawSkills: readonly unknown[]): void => {
		if (captured) return;
		const outputPath = process.env.PI_SKILL_OPTIMIZER_CORPUS_CAPTURE?.trim();
		const salt = process.env.PI_SKILL_OPTIMIZER_CORPUS_SALT?.trim();
		if (!outputPath || !salt) throw new Error("corpus capture path and salt are required");
		const skills = rawSkills.flatMap((value) => {
			if (!value || typeof value !== "object") return [];
			const skill = value as Record<string, unknown>;
			if (typeof skill.name !== "string" || typeof skill.description !== "string") return [];
			const location = [skill.location, skill.filePath, skill.path].find((entry): entry is string => typeof entry === "string" && entry.length > 0);
			return [{ name: skill.name, description: skill.description, location: location || `/missing-root/${skill.name}/SKILL.md` }];
		});
		if (skills.length === 0) return;
		writePrivateJson(outputPath, createCatalogExampleV1({ label: "real Pi catalog", skills }, salt));
		captured = true;
	};

	pi.on("session_start", (_event, ctx) => {
		save(ctx.getSystemPromptOptions().skills ?? []);
	});
	pi.on("before_provider_request", (event) => {
		if (captured) return;
		const surfaces: string[] = [];
		stringsIn(event.payload, surfaces);
		const candidates = surfaces.flatMap((text) => [...text.matchAll(BLOCK_RE)].map((match) => parseSkills(match[1])));
		const skills = candidates.sort((a, b) => b.length - a.length)[0];
		if (!skills || skills.length === 0) return;
		save(skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				location: skill.location || `/missing-root/${skill.name}/SKILL.md`,
			})));
	});
}
