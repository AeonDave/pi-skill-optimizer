export const ACTIVATION_TASKS = [
	"software-design",
	"software-change",
	"software-debug",
	"software-test",
	"software-review",
	"software-read",
	"docs-write",
	"docs-review",
	"data-analysis",
	"research",
	"operations",
] as const;

export type ActivationTask = (typeof ACTIVATION_TASKS)[number];
export type SkillActivationKind = "specialist" | "workflow" | "behavioral";

export interface SkillActivation {
	kind: SkillActivationKind;
	tasks: ActivationTask[];
}

const ACTIVATION_KINDS: ReadonlySet<string> = new Set(["specialist", "workflow", "behavioral"]);
const ACTIVATION_TASK_SET: ReadonlySet<string> = new Set(ACTIVATION_TASKS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivationKind(value: unknown): value is SkillActivationKind {
	return typeof value === "string" && ACTIVATION_KINDS.has(value);
}

/** Keep only exact names and validated activation tags from untrusted generated JSON. */
export function normalizeActivation(value: unknown): Record<string, SkillActivation> {
	const normalized: Record<string, SkillActivation> = {};
	if (!isRecord(value)) return normalized;

	for (const [rawOwner, rawActivation] of Object.entries(value)) {
		const owner = rawOwner.trim();
		if (!owner || Object.prototype.hasOwnProperty.call(normalized, owner) || !isRecord(rawActivation)) continue;
		if (!isActivationKind(rawActivation.kind) || !Array.isArray(rawActivation.tasks)) continue;

		const tasks: ActivationTask[] = [];
		const seen = new Set<ActivationTask>();
		for (const task of rawActivation.tasks) {
			if (typeof task !== "string" || !ACTIVATION_TASK_SET.has(task)) continue;
			const activationTask = task as ActivationTask;
			if (seen.has(activationTask)) continue;
			seen.add(activationTask);
			tasks.push(activationTask);
		}
		if (tasks.length === 0) continue;

		Object.defineProperty(normalized, owner, {
			value: { kind: rawActivation.kind, tasks },
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}

	return normalized;
}

/** Return one-hop workflow/behavioral companions with shared task tags. */
export function contextualSkillNames(
	activation: Readonly<Record<string, SkillActivation>> | undefined,
	primaryName: string | undefined,
): string[] {
	if (!activation || !primaryName || !Object.prototype.hasOwnProperty.call(activation, primaryName)) return [];
	const primary = activation[primaryName];
	if (!primary || !Array.isArray(primary.tasks) || primary.tasks.length === 0) return [];

	const primaryTasks = new Set(primary.tasks);
	const candidates: Array<{ name: string; overlap: number }> = [];
	for (const [name, candidate] of Object.entries(activation)) {
		if (name === primaryName || (candidate.kind !== "workflow" && candidate.kind !== "behavioral")) continue;
		const candidateTasks = new Set(candidate.tasks);
		let overlap = 0;
		for (const task of primaryTasks) if (candidateTasks.has(task)) overlap += 1;
		if (overlap > 0) candidates.push({ name, overlap });
	}
	candidates.sort((left, right) =>
		right.overlap - left.overlap || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
	);
	return candidates.map(({ name }) => name);
}
