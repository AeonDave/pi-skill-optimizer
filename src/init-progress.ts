import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface InitProgressOptions {
	total: number;
	alreadyCurrent: number;
	catalogTotal: number;
	model: string;
}

export interface InitProgress {
	startAttempt(label: string, attempt: number, skillCount: number): void;
	activity(kind: "connected" | "thinking" | "text", chars?: number): void;
	/** Cumulative skills committed during this init, excluding already-current cards. */
	saved(count: number): void;
	report(message: string): void;
	finish(status: "done" | "incomplete" | "failed" | "cancelled"): void;
	dispose(): void;
}

const WIDGET_KEY = "skill-optimizer-init";
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function count(value: number, maximum = MAX_COUNTER): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

/** Plain, bounded UI labels: no terminal controls, bidi overrides or malformed UTF-16. */
function label(value: string, maximum: number): string {
	const safe = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD")
		.replace(/\s+/gu, " ")
		.trim();
	if (safe.length <= maximum) return safe;
	let end = maximum - 3;
	if (/[\uD800-\uDBFF]/u.test(safe[end - 1] ?? "")) end -= 1;
	return `${safe.slice(0, end)}...`;
}

/** Live operation UI only. Provider activity records counters, never response text. */
export function createInitProgress(
	ui: Pick<ExtensionContext["ui"], "setWidget">,
	options: InitProgressOptions,
): InitProgress {
	const total = count(options.total);
	const catalogTotal = count(options.catalogTotal);
	const alreadyCurrent = count(options.alreadyCurrent, catalogTotal);
	const model = label(options.model, 100);
	const startedAt = Date.now();
	let saved = 0;
	let attempt: { label: string; number: number; skills: number } | undefined;
	let phase: "preparing" | "awaiting provider" | "stream started" | "thinking" | "generating" = "preparing";
	let lastProviderEvent: number | undefined;
	let thinkingChars = 0;
	let textChars = 0;
	let message: string | undefined;
	let finished: Parameters<InitProgress["finish"]>[0] | undefined;
	let disposed = false;
	let lastRendered: readonly string[] | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const active = (): boolean => !disposed && finished === undefined;
	const secondsSince = (timestamp: number): number => Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	const stopTimer = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const render = (): void => {
		if (disposed) return;
		const percent = total > 0 ? Math.floor(saved * 100 / total) : finished === "done" ? 100 : 0;
		const current = Math.min(catalogTotal, alreadyCurrent + saved);
		const providerAge = lastProviderEvent === undefined ? "provider events: none" : `last provider event ${secondsSince(lastProviderEvent)}s ago`;
		const phaseLabel = phase === "thinking" ? `thinking (${thinkingChars} chars)`
			: phase === "generating" ? `generating (${textChars} chars)` : phase;
		const lines = [
			`skill-optimizer init${finished ? ` ${finished}` : ""}: ${percent}% (${saved}/${total} saved; ${current}/${catalogTotal} current)`,
			`${attempt ? `batch ${attempt.label} | attempt ${attempt.number} | ${attempt.skills} skills | ` : ""}model ${model}`,
			`${finished ?? phaseLabel} | ${secondsSince(startedAt)}s elapsed | ${providerAge}`,
			...(message ? [message] : []),
			...(finished ? [] : ["/skill-optimizer cancel"]),
		];
		if (lastRendered?.length === lines.length && lastRendered.every((line, index) => line === lines[index])) return;
		try {
			ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
			lastRendered = lines;
		} catch {
			// Cosmetic UI failure must not interrupt profile generation or checkpointing.
		}
	};
	render();
	timer = setInterval(render, 1_000);
	timer.unref?.();
	return {
		startAttempt(batchLabel, attemptNumber, skillCount) {
			if (!active()) return;
			attempt = { label: label(batchLabel, 64), number: count(attemptNumber), skills: count(skillCount) };
			phase = "awaiting provider";
			lastProviderEvent = undefined;
			thinkingChars = 0;
			textChars = 0;
			message = undefined;
			render();
		},
		activity(kind, chars = 0) {
			if (!active()) return;
			lastProviderEvent = Date.now();
			if (kind === "thinking") {
				phase = "thinking";
				thinkingChars = Math.min(MAX_COUNTER, thinkingChars + count(chars));
			} else if (kind === "text") {
				phase = "generating";
				textChars = Math.min(MAX_COUNTER, textChars + count(chars));
			} else if (phase === "awaiting provider" || phase === "preparing") phase = "stream started";
		},
		saved(committed) {
			if (!active()) return;
			saved = Math.max(saved, count(committed, total));
			render();
		},
		report(nextMessage) {
			if (!active()) return;
			message = label(nextMessage, 240) || undefined;
			render();
		},
		finish(status) {
			if (!active()) return;
			finished = status;
			stopTimer();
			render();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopTimer();
			try {
				ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
			} catch {
				// The session UI may already have been torn down.
			}
		},
	};
}
