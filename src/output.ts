/**
 * Deterministic, dependency-free tool-output reducer — no Pi imports, unit-testable.
 *
 * Shrinks noisy tool output (e.g. bash stdout) while preserving the signal:
 * the head, the tail (where errors/stack traces usually land), and any line
 * matching a "signal" pattern (error/warning/failure/...). The middle is elided
 * with a counted marker. Pure string processing, cross-OS (handles CRLF/LF).
 *
 * This is the transparent slice of output-compression tools: it runs at
 * `tool_result` time (once, cache-stable) and never needs the model to call a
 * tool. It is off by default — altering tool output is higher-risk than slimming
 * the prompt, so it is strictly opt-in and quality-first (signal lines survive).
 */

/** Lines matching any of these are always kept (case-insensitive where noted). */
export const DEFAULT_OUTPUT_PATTERNS: readonly RegExp[] = [
	/\b(error|errors|errno|failed|failure|fatal|panic|exception|traceback|stack\s?trace|denied|refused|cannot|unable|timed?\s?out|segfault|core dumped|assert(ion)?)\b/i,
	/\b(warning|warn|deprecat)\b/i,
	/^\s*at\s+\S/, // stack frames
	/\bE\d{2,}\b/, // error codes like E404, ENOENT-ish
	/(^|\s)(FAIL|FAILED|✗|×|✖)(\s|$|:)/,
	/\b(exit(ed)?\s+(code|status)|non-zero)\b/i,
];

export interface OutputReduceOptions {
	/** Only reduce when the text exceeds this many lines OR `maxBytes`. */
	maxLines: number;
	maxBytes: number;
	/** Lines kept from the start and end. */
	headLines: number;
	tailLines: number;
	/** A single kept line longer than this is truncated (giant one-line JSON/logs). */
	maxLineBytes: number;
	/** Lines matching any pattern are always kept. */
	patterns: readonly RegExp[];
}

export interface OutputReduceResult {
	text: string;
	reduced: boolean;
	fromLines: number;
	toLines: number;
	fromBytes: number;
	toBytes: number;
}

export const DEFAULT_OUTPUT_OPTIONS: OutputReduceOptions = {
	maxLines: 200,
	maxBytes: 16_000,
	headLines: 40,
	tailLines: 60,
	maxLineBytes: 2_000,
	patterns: DEFAULT_OUTPUT_PATTERNS,
};

/** Best-effort program name of a shell command (strips env assigns, sudo/env/time, path, .exe). */
export function commandProgram(command: string): string {
	let s = command.trim();
	s = s.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
	const tokens = s.split(/\s+/).filter(Boolean);
	let prog = tokens[0] ?? "";
	if (["sudo", "env", "command", "time", "nice", "nohup"].includes(prog) && tokens[1]) prog = tokens[1];
	return prog.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");
}

/** True when the command's program is in the exclude list (extract → deterministic smart). */
export function isExcludedCommand(command: string, exclude: readonly string[]): boolean {
	if (!command || exclude.length === 0) return false;
	const prog = commandProgram(command);
	return exclude.some((e) => e.toLowerCase() === prog);
}

/** Verbatim signal lines (errors/warnings/...), capped, for the always-keep guarantee. */
export function signalLines(text: string, patterns: readonly RegExp[] = DEFAULT_OUTPUT_PATTERNS, max = 60): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (patterns.some((p) => p.test(line))) {
			out.push(line);
			if (out.length >= max) break;
		}
	}
	return out;
}

/**
 * Build the prompt for the "intelligent grep" extraction pass: a weak model is
 * asked to return ONLY the verbatim lines relevant to the request — it extracts,
 * it does not summarize. Output stays raw and technical so it is useful to the
 * main thread. The full output is capped to bound cost.
 */
export function buildExtractPrompt(request: string, command: string, output: string, maxBytes = 64_000): { system: string; user: string } {
	const clipped = output.length > maxBytes ? `${output.slice(0, maxBytes)}\n…(truncated for extraction)` : output;
	const system = [
		"You prepare the exact data the REQUEST needs, extracted from COMMAND OUTPUT. You EXTRACT/SELECT, you do NOT summarize, rephrase, or invent.",
		"Return the relevant lines/values copied byte-for-byte from the output, ready to be used directly by the main agent.",
		"Hard rules: technical only, no prose, no commentary, no markdown, no code fences, no headers you add yourself. Never output a value that is not present verbatim in the output.",
		"Always include every error / warning / failure / stack-frame line verbatim.",
		"Keep it minimal: only what helps answer the request; drop the noise.",
		"If nothing is clearly relevant, return the first 20 and the last 20 lines verbatim.",
	].join("\n");
	const user = `REQUEST:\n${request || "(no explicit request — keep errors and a representative head+tail)"}\n\nCOMMAND:\n${command || "(unknown)"}\n\nCOMMAND OUTPUT:\n${clipped}`;
	return { system, user };
}

/** Ensure every `signal` line is present in `extracted` (prepended verbatim if missing). */
export function mergeExtracted(extracted: string, signal: readonly string[]): string {
	const body = extracted.trim();
	const present = new Set(body.split(/\r?\n/).map((l) => l.trim()));
	const missing = signal.filter((s) => !present.has(s.trim()));
	if (missing.length === 0) return body;
	return [...missing, "", body].join("\n");
}

function truncateLine(line: string, maxLineBytes: number): string {
	if (line.length <= maxLineBytes) return line;
	return `${line.slice(0, maxLineBytes)}… (+${line.length - maxLineBytes} chars)`;
}

/**
 * Reduce `text` per options. Returns the original (and `reduced: false`) when it
 * is within the thresholds or when reduction would not actually shrink it.
 */
export function reduceOutput(text: string, options: Partial<OutputReduceOptions> = {}): OutputReduceResult {
	const opts: OutputReduceOptions = { ...DEFAULT_OUTPUT_OPTIONS, ...options };
	const fromBytes = text.length;
	const lines = text.split(/\r?\n/);
	const fromLines = lines.length;

	if (fromLines <= opts.maxLines && fromBytes <= opts.maxBytes) {
		return { text, reduced: false, fromLines, toLines: fromLines, fromBytes, toBytes: fromBytes };
	}

	const head = Math.max(0, opts.headLines);
	const tail = Math.max(0, opts.tailLines);
	const keep = new Set<number>();
	for (let i = 0; i < Math.min(head, fromLines); i++) keep.add(i);
	for (let i = Math.max(0, fromLines - tail); i < fromLines; i++) keep.add(i);
	for (let i = 0; i < fromLines; i++) {
		if (opts.patterns.some((p) => p.test(lines[i]))) keep.add(i);
	}

	const sorted = [...keep].sort((a, b) => a - b);
	const out: string[] = [];
	let prev = -1;
	for (const i of sorted) {
		if (prev >= 0 && i > prev + 1) out.push(`… (${i - prev - 1} lines omitted) …`);
		out.push(truncateLine(lines[i], opts.maxLineBytes));
		prev = i;
	}
	if (prev < fromLines - 1) out.push(`… (${fromLines - 1 - prev} lines omitted) …`);

	const next = out.join("\n");
	if (next.length >= fromBytes) {
		return { text, reduced: false, fromLines, toLines: fromLines, fromBytes, toBytes: fromBytes };
	}
	return { text: next, reduced: true, fromLines, toLines: out.length, fromBytes, toBytes: next.length };
}
