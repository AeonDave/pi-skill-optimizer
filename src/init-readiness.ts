import { createHash } from "node:crypto";

import { diffSkills, type SkillOptimizerProfile, type SkillRef } from "./profile.ts";

export const INIT_READINESS_ENTRY_TYPE = "skill-optimizer-init-readiness";

export type InitReadinessStatus = "empty" | "manual" | "outdated" | "incomplete" | "current";
export type InitNoticeStatus = Extract<InitReadinessStatus, "empty" | "outdated" | "incomplete">;

export interface InitReadinessProfile {
	exists: boolean;
	profile: SkillOptimizerProfile;
	hashes: Record<string, string>;
	initVersion: number;
}

export interface InitReadinessScope {
	stored: InitReadinessProfile;
	skills: readonly SkillRef[];
}

export interface InitReadinessInput {
	scopeKey: string;
	initVersion: number;
	global: InitReadinessScope;
	project?: InitReadinessScope;
}

export interface InitReadiness {
	status: InitReadinessStatus;
	skillCount: number;
	catalogKey: string;
}

function hasProfileContent(profile: SkillOptimizerProfile): boolean {
	return profile.critical.length > 0
		|| Object.keys(profile.queries).length > 0
		|| Object.keys(profile.clusters).length > 0
		|| Object.keys(profile.negativeHints).length > 0
		|| Object.keys(profile.activation ?? {}).length > 0;
}

function hasGeneratedMetadata(stored: InitReadinessProfile): boolean {
	return stored.initVersion > 0 || Object.keys(stored.hashes).length > 0;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildInitCatalogKey(input: InitReadinessInput): string {
	const scopes = [
		{ name: "global", skills: input.global.skills },
		...(input.project ? [{ name: "project", skills: input.project.skills }] : []),
	];
	return JSON.stringify(scopes.map((scope) => [
		scope.name,
		scope.skills.map((skill) => [skill.name, skill.description]),
	]));
}

/** Evaluate generated metadata separately from optional profile fields such as activation tags. */
export function buildInitReadiness(input: InitReadinessInput, catalogKey = buildInitCatalogKey(input)): InitReadiness {
	const scopes = [
		{ name: "global", ...input.global },
		...(input.project ? [{ name: "project", ...input.project }] : []),
	];
	const skillCount = scopes.reduce((count, scope) => count + scope.skills.length, 0);
	const populated = scopes.filter((scope) => scope.stored.exists && hasProfileContent(scope.stored.profile));
	const generated = scopes.filter((scope) => scope.stored.exists && hasGeneratedMetadata(scope.stored));

	if (generated.length === 0 && populated.length === 0) {
		return { status: "empty", skillCount, catalogKey };
	}
	if (generated.some((scope) => scope.stored.initVersion !== input.initVersion)) {
		return { status: "outdated", skillCount, catalogKey };
	}

	for (const scope of scopes) {
		const manual = scope.stored.exists
			&& hasProfileContent(scope.stored.profile)
			&& !hasGeneratedMetadata(scope.stored);
		if (manual) continue;
		if (!scope.stored.exists) {
			if (scope.skills.length > 0) return { status: "incomplete", skillCount, catalogKey };
			continue;
		}
		if (!hasGeneratedMetadata(scope.stored)) {
			if (scope.skills.length > 0) return { status: "incomplete", skillCount, catalogKey };
			continue;
		}
		const diff = diffSkills(scope.skills, scope.stored.hashes);
		if (diff.changed.length > 0 || diff.removed.length > 0) {
			return { status: "incomplete", skillCount, catalogKey };
		}
	}

	if (populated.some((scope) => !hasGeneratedMetadata(scope.stored))) {
		return { status: "manual", skillCount, catalogKey };
	}
	return { status: "current", skillCount, catalogKey };
}

/** A bounded, non-sensitive marker key for one scope, init version, and actionable readiness state. */
export function buildInitNoticeKey(scopeKey: string, initVersion: number, status: InitNoticeStatus): string {
	return digest(JSON.stringify([scopeKey, initVersion, status]));
}

/** Recover notice keys from Pi's custom session entries, which are not LLM messages. */
export function readInitNoticeKeys(entries: readonly unknown[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== INIT_READINESS_ENTRY_TYPE) continue;
		if (!candidate.data || typeof candidate.data !== "object") continue;
		const data = candidate.data as { schema?: unknown; key?: unknown };
		if (data.schema === 1 && typeof data.key === "string" && /^[a-f0-9]{64}$/.test(data.key)) {
			keys.add(data.key);
		}
	}
	return keys;
}
