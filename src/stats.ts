/**
 * Pure telemetry accounting for tokens saved, split by area. No Pi imports.
 *
 * Tracks characters removed per area (skills catalog, tools array, tool output)
 * so the user can see where the savings come from. Persisted as a small global
 * stats file; tokens are derived as chars/4 at display time.
 */

export type SavingsArea = "skills" | "tools" | "output";

export interface SavingsByArea {
	skills: number;
	tools: number;
	output: number;
}

export interface StatsFile {
	version: 1;
	updatedAt: string;
	lifetime: SavingsByArea;
}

export const EMPTY_SAVINGS: SavingsByArea = { skills: 0, tools: 0, output: 0 };

function nonNeg(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeSavings(value: unknown): SavingsByArea {
	const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	return { skills: nonNeg(o.skills), tools: nonNeg(o.tools), output: nonNeg(o.output) };
}

/** Read lifetime savings from a parsed stats file (tolerates a bare SavingsByArea too). */
export function normalizeStatsFile(value: unknown): SavingsByArea {
	const o = value && typeof value === "object" && !Array.isArray(value) ? (value as { lifetime?: unknown }) : {};
	return normalizeSavings("lifetime" in o ? o.lifetime : o);
}

export function addSavings(a: SavingsByArea, b: SavingsByArea): SavingsByArea {
	return { skills: a.skills + b.skills, tools: a.tools + b.tools, output: a.output + b.output };
}

export function totalSavings(s: SavingsByArea): number {
	return s.skills + s.tools + s.output;
}

export function toStatsFile(lifetime: SavingsByArea, now = Date.now()): StatsFile {
	return { version: 1, updatedAt: new Date(now).toISOString(), lifetime };
}
