/**
 * Pure persistent telemetry. Savings are characters removed, never token
 * counts. Extraction guard outcomes are separate event counters.
 */

export type SavingsArea = "skills" | "tools" | "output";

export interface SavingsByArea {
	skills: number;
	tools: number;
	output: number;
}

export interface ExtractionTelemetry {
	attempts: number;
	accepted: number;
	fallbackEvidence: number;
	fallbackSavings: number;
	fallbackError: number;
}

export interface StatsFile {
	version: 2;
	updatedAt: string;
	/** Lifetime characters removed by optimization area. */
	lifetime: SavingsByArea;
	extraction: ExtractionTelemetry;
}

export const EMPTY_SAVINGS: SavingsByArea = { skills: 0, tools: 0, output: 0 };
export const EMPTY_EXTRACTION_TELEMETRY: ExtractionTelemetry = {
	attempts: 0,
	accepted: 0,
	fallbackEvidence: 0,
	fallbackSavings: 0,
	fallbackError: 0,
};

function nonNeg(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeSavings(value: unknown): SavingsByArea {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return { skills: nonNeg(source.skills), tools: nonNeg(source.tools), output: nonNeg(source.output) };
}

/** Read lifetime character savings from v1/v2 or a bare legacy object. */
export function normalizeStatsFile(value: unknown): SavingsByArea {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return normalizeSavings("lifetime" in source ? source.lifetime : source);
}

/** Read extraction counters from a complete stats file or a bare counter object. */
export function normalizeExtractionTelemetry(value: unknown): ExtractionTelemetry {
	const outer = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const source = outer.extraction && typeof outer.extraction === "object" && !Array.isArray(outer.extraction)
		? outer.extraction as Record<string, unknown>
		: outer;
	return {
		attempts: nonNeg(source.attempts),
		accepted: nonNeg(source.accepted),
		fallbackEvidence: nonNeg(source.fallbackEvidence),
		fallbackSavings: nonNeg(source.fallbackSavings),
		fallbackError: nonNeg(source.fallbackError),
	};
}

export function addSavings(a: SavingsByArea, b: SavingsByArea): SavingsByArea {
	return { skills: a.skills + b.skills, tools: a.tools + b.tools, output: a.output + b.output };
}

export function subtractSavings(a: SavingsByArea, b: SavingsByArea): SavingsByArea {
	return {
		skills: Math.max(0, a.skills - b.skills),
		tools: Math.max(0, a.tools - b.tools),
		output: Math.max(0, a.output - b.output),
	};
}

export function totalSavings(savings: SavingsByArea): number {
	return savings.skills + savings.tools + savings.output;
}

export function addExtractionTelemetry(a: ExtractionTelemetry, b: ExtractionTelemetry): ExtractionTelemetry {
	return {
		attempts: a.attempts + b.attempts,
		accepted: a.accepted + b.accepted,
		fallbackEvidence: a.fallbackEvidence + b.fallbackEvidence,
		fallbackSavings: a.fallbackSavings + b.fallbackSavings,
		fallbackError: a.fallbackError + b.fallbackError,
	};
}

export function subtractExtractionTelemetry(a: ExtractionTelemetry, b: ExtractionTelemetry): ExtractionTelemetry {
	return {
		attempts: Math.max(0, a.attempts - b.attempts),
		accepted: Math.max(0, a.accepted - b.accepted),
		fallbackEvidence: Math.max(0, a.fallbackEvidence - b.fallbackEvidence),
		fallbackSavings: Math.max(0, a.fallbackSavings - b.fallbackSavings),
		fallbackError: Math.max(0, a.fallbackError - b.fallbackError),
	};
}

export function totalExtractionEvents(telemetry: ExtractionTelemetry): number {
	return Object.values(telemetry).reduce((sum, value) => sum + value, 0);
}

export function toStatsFile(
	lifetime: SavingsByArea,
	now = Date.now(),
	extraction: ExtractionTelemetry = EMPTY_EXTRACTION_TELEMETRY,
): StatsFile {
	return { version: 2, updatedAt: new Date(now).toISOString(), lifetime, extraction };
}
