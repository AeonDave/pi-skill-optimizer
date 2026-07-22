/**
 * Pure, dependency-free tool-output reduction.
 *
 * The deterministic reducer keeps bounded context around protected evidence. A
 * model-assisted extraction is never trusted directly: it must contain only
 * verbatim source lines, retain every protected line, and save enough UTF-8
 * bytes to justify replacing the original. Rejected extraction falls back to
 * the deterministic reducer, then to the original text.
 */

/** Evidence that may not be discarded by either reduction strategy. */
export const DEFAULT_OUTPUT_PATTERNS: readonly RegExp[] = [
	/\b(error|errors|errno|failed|failure|fatal|panic|exception|traceback|stack\s?trace|denied|refused|cannot|unable|timed?\s?out|segfault|core dumped|assert(ion)?)\b/i,
	/\b(warning|warn|deprecat)\b/i,
	/^\s*at\s+\S/, // JavaScript and similar stack frames
	/^\s*(?:Caused by:|npm\s+ERR!|error\[E\d+\])/i,
	/\b(?:E\d{2,}|ENOENT|EACCES|EPERM|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/,
	/(^|\s)(FAIL|FAILED|not ok|✗|×|✖)(\s|$|:)/i,
	/\b(exit(?:ed)?\s+(?:code|status)|non-zero)\b/i,
	/^\s*(?:(?:tests?|suites?)\s*:\s*.*\bfailed\b|failures?\s*:\s*[1-9]\d*|(?:expected|actual|received)\s*:)/i,
	/(?:^|[\s("'`])(?:[A-Za-z]:[\\/]|\/|\.{0,2}[\\/])?[^\s:()[\]{}"'`]+\.[A-Za-z0-9]{1,12}:\d+(?::\d+)?\b/,
	/^\s*File\s+["'][^"']+["'],\s+line\s+\d+/i,
	/(?:^\s*(?:[-*]\s*)?(?:constraint|requirement|required|must(?:\s+not)?|do\s+not|never|shall(?:\s+not)?)\b|\b(?:must(?:\s+not)?|shall(?:\s+not)?|is required to)\b)/i,
];

export interface OutputReduceOptions {
	/** Only reduce when the text exceeds this many lines or UTF-8 bytes. */
	maxLines: number;
	maxBytes: number;
	/** Lines kept from the start and end. */
	headLines: number;
	tailLines: number;
	/** UTF-8 byte cap for ordinary kept lines. Protected lines stay verbatim. */
	maxLineBytes: number;
	/** Additional project-specific evidence patterns. Core evidence always applies. */
	patterns: readonly RegExp[];
	/** Ordinary lines retained on each side of protected evidence. */
	contextLines?: number;
	/** A reduction must satisfy both minimums. Set either to zero to disable it. */
	minSavingsBytes?: number;
	minSavingsRatio?: number;
}

export interface OutputReduceResult {
	text: string;
	reduced: boolean;
	fromLines: number;
	toLines: number;
	fromBytes: number;
	toBytes: number;
}

export const DEFAULT_OUTPUT_OPTIONS: Required<OutputReduceOptions> = {
	maxLines: 200,
	maxBytes: 16_000,
	headLines: 40,
	tailLines: 60,
	maxLineBytes: 2_000,
	patterns: DEFAULT_OUTPUT_PATTERNS,
	contextLines: 1,
	minSavingsBytes: 512,
	minSavingsRatio: 0.1,
};

export type ExtractStrategy = "extract" | "smart" | "original";
export type ExtractRejectionReason =
	| "empty-extraction"
	| "non-verbatim-line"
	| "out-of-order-line"
	| "missing-protected-evidence"
	| "insufficient-benefit";

export interface ExtractValidationOptions {
	/** Options for the deterministic fallback. */
	smartOptions?: Partial<OutputReduceOptions>;
	/** Additional lines that both strategies must preserve verbatim. */
	protectedPatterns?: readonly RegExp[];
	/** Extraction and smart fallback must satisfy both minimums. */
	minSavingsBytes?: number;
	minSavingsRatio?: number;
}

export interface ExtractValidationResult extends OutputReduceResult {
	strategy: ExtractStrategy;
	/** Present when model output was rejected, including when smart recovered. */
	rejectionReason?: ExtractRejectionReason;
}

interface ResolvedOutputReduceOptions {
	maxLines: number;
	maxBytes: number;
	headLines: number;
	tailLines: number;
	maxLineBytes: number;
	patterns: readonly RegExp[];
	contextLines: number;
	minSavingsBytes: number;
	minSavingsRatio: number;
}

/** Exact UTF-8 size used by every byte-oriented limit and metric in this module. */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Return the longest prefix within `maxBytes`, never splitting a code point. */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes === Number.POSITIVE_INFINITY) return text;
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	if (limit === 0) return "";
	if (utf8ByteLength(text) <= limit) return text;

	let used = 0;
	let end = 0;
	for (const codePoint of text) {
		const bytes = utf8ByteLength(codePoint);
		if (used + bytes > limit) break;
		used += bytes;
		end += codePoint.length;
	}
	return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	if (limit === 0) return "";
	if (utf8ByteLength(text) <= limit) return text;

	let used = 0;
	let start = text.length;
	while (start > 0) {
		let next = start - 1;
		const unit = text.charCodeAt(next);
		if (unit >= 0xdc00 && unit <= 0xdfff && next > 0) {
			const previous = text.charCodeAt(next - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) next--;
		}
		const codePoint = text.slice(next, start);
		const bytes = utf8ByteLength(codePoint);
		if (used + bytes > limit) break;
		used += bytes;
		start = next;
	}
	return text.slice(start);
}

function clipUtf8HeadTail(text: string, maxBytes: number): string {
	if (maxBytes === Number.POSITIVE_INFINITY || utf8ByteLength(text) <= maxBytes) return text;
	const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
	if (limit === 0) return "";
	const marker = "\n...[middle truncated for extraction]...\n";
	const markerBytes = utf8ByteLength(marker);
	if (markerBytes >= limit) return truncateUtf8Bytes(text, limit);

	const contentBudget = limit - markerBytes;
	const headBudget = Math.ceil(contentBudget * 0.6);
	const tailBudget = contentBudget - headBudget;
	return `${truncateUtf8Bytes(text, headBudget)}${marker}${utf8Suffix(text, tailBudget)}`;
}

function nonNegative(value: number | undefined, fallback: number): number {
	if (value === Number.POSITIVE_INFINITY) return value;
	return Number.isFinite(value) ? Math.max(0, value as number) : fallback;
}

function resolveOptions(options: Partial<OutputReduceOptions>): ResolvedOutputReduceOptions {
	return {
		maxLines: Math.floor(nonNegative(options.maxLines, DEFAULT_OUTPUT_OPTIONS.maxLines)),
		maxBytes: Math.floor(nonNegative(options.maxBytes, DEFAULT_OUTPUT_OPTIONS.maxBytes)),
		headLines: Math.floor(nonNegative(options.headLines, DEFAULT_OUTPUT_OPTIONS.headLines)),
		tailLines: Math.floor(nonNegative(options.tailLines, DEFAULT_OUTPUT_OPTIONS.tailLines)),
		maxLineBytes: Math.floor(nonNegative(options.maxLineBytes, DEFAULT_OUTPUT_OPTIONS.maxLineBytes)),
		patterns: options.patterns ?? DEFAULT_OUTPUT_OPTIONS.patterns,
		contextLines: Math.floor(nonNegative(options.contextLines, DEFAULT_OUTPUT_OPTIONS.contextLines)),
		minSavingsBytes: Math.floor(nonNegative(options.minSavingsBytes, DEFAULT_OUTPUT_OPTIONS.minSavingsBytes)),
		minSavingsRatio: Math.min(1, nonNegative(options.minSavingsRatio, DEFAULT_OUTPUT_OPTIONS.minSavingsRatio)),
	};
}

function testPattern(pattern: RegExp, line: string): boolean {
	pattern.lastIndex = 0;
	const matched = pattern.test(line);
	pattern.lastIndex = 0;
	return matched;
}

function matchesAny(line: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => testPattern(pattern, line));
}

function combinedEvidencePatterns(additional: readonly RegExp[] | undefined): readonly RegExp[] {
	if (!additional || additional === DEFAULT_OUTPUT_PATTERNS || additional.length === 0) return DEFAULT_OUTPUT_PATTERNS;
	return [...DEFAULT_OUTPUT_PATTERNS, ...additional];
}

/** True only when replacing `fromBytes` satisfies both configured savings floors. */
export function hasMinimumSavings(fromBytes: number, toBytes: number, minBytes: number, minRatio: number): boolean {
	if (fromBytes <= 0 || toBytes >= fromBytes) return false;
	const saved = fromBytes - toBytes;
	return saved >= Math.max(0, minBytes) && saved / fromBytes >= Math.max(0, Math.min(1, minRatio));
}

/** True when a registered command looks like it comes from an RTK extension. */
export function isRtkSource(name: string, path: string, source: string): boolean {
	return /rtk/i.test(path) || /rtk/i.test(source) || /\brtk\b/i.test(name);
}

/** Best-effort program name of a shell command. */
export function commandProgram(command: string): string {
	let s = command.trim();
	s = s.replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
	const tokens = s.split(/\s+/).filter(Boolean);
	let prog = tokens[0] ?? "";
	if (["sudo", "env", "command", "time", "nice", "nohup"].includes(prog) && tokens[1]) prog = tokens[1];
	return prog.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");
}

/** True when the command's program is in the extract-exclusion list. */
export function isExcludedCommand(command: string, exclude: readonly string[]): boolean {
	if (!command || exclude.length === 0) return false;
	const prog = commandProgram(command);
	return exclude.some((entry) => entry.toLowerCase() === prog);
}

/** Collect protected evidence verbatim, including repeated occurrences. */
export function protectedEvidenceLines(
	text: string,
	additionalPatterns: readonly RegExp[] = [],
	max = Number.POSITIVE_INFINITY,
): string[] {
	const patterns = combinedEvidencePatterns(additionalPatterns);
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : Number.POSITIVE_INFINITY;
	if (limit === 0) return [];
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (matchesAny(line, patterns)) {
			out.push(line);
			if (out.length >= limit) break;
		}
	}
	return out;
}

/**
	* Build the prompt for a model-assisted verbatim selection pass. The command
	* output is clipped by real UTF-8 bytes and retains both head and tail.
	*/
export function buildExtractPrompt(request: string, command: string, output: string, maxBytes = 64_000): { system: string; user: string } {
	const clipped = clipUtf8HeadTail(output, maxBytes);
	const system = [
		"Select the exact COMMAND OUTPUT lines needed for the REQUEST. Do not summarize, rephrase, infer, or invent.",
		"Return only complete lines copied character-for-character, including leading whitespace, in their original order and without duplicates.",
		"No prose, commentary, markdown, code fences, or headers. Never return a line absent from COMMAND OUTPUT.",
		"Always retain errors, warnings, stack frames, exit failures, failed tests and assertions, path-and-line diagnostics, and explicit constraints.",
		"Keep the result minimal. If relevance is unclear, select a representative head and tail plus all protected evidence.",
		"Do not return the synthetic middle-truncation marker.",
	].join("\n");
	const user = `REQUEST:\n${request || "(no explicit request)"}\n\nCOMMAND:\n${command || "(unknown)"}\n\nCOMMAND OUTPUT:\n${clipped}`;
	return { system, user };
}

function truncateLine(line: string, maxLineBytes: number): string {
	const totalBytes = utf8ByteLength(line);
	if (totalBytes <= maxLineBytes) return line;
	const largestMarker = `... (+${totalBytes} bytes)`;
	const markerBudget = utf8ByteLength(largestMarker);
	if (markerBudget >= maxLineBytes) return truncateUtf8Bytes(line, maxLineBytes);
	const prefix = truncateUtf8Bytes(line, maxLineBytes - markerBudget);
	const marker = `... (+${totalBytes - utf8ByteLength(prefix)} bytes)`;
	return `${prefix}${marker}`;
}

function unchangedResult(text: string, lines: number, bytes: number): OutputReduceResult {
	return { text, reduced: false, fromLines: lines, toLines: lines, fromBytes: bytes, toBytes: bytes };
}

/**
	* Deterministically keep head, tail, protected evidence, and bounded evidence
	* context. The original is returned if the result is not materially smaller.
	*/
export function reduceOutput(text: string, options: Partial<OutputReduceOptions> = {}): OutputReduceResult {
	const opts = resolveOptions(options);
	const fromBytes = utf8ByteLength(text);
	const lines = text.split(/\r?\n/);
	const fromLines = lines.length;

	if (fromLines <= opts.maxLines && fromBytes <= opts.maxBytes) return unchangedResult(text, fromLines, fromBytes);

	const evidencePatterns = combinedEvidencePatterns(opts.patterns);
	const evidence = new Set<number>();
	const keep = new Set<number>();
	for (let i = 0; i < Math.min(opts.headLines, fromLines); i++) keep.add(i);
	for (let i = Math.max(0, fromLines - opts.tailLines); i < fromLines; i++) keep.add(i);
	for (let i = 0; i < fromLines; i++) {
		if (!matchesAny(lines[i], evidencePatterns)) continue;
		evidence.add(i);
		for (let j = Math.max(0, i - opts.contextLines); j <= Math.min(fromLines - 1, i + opts.contextLines); j++) keep.add(j);
	}

	const sorted = [...keep].sort((a, b) => a - b);
	const out: string[] = [];
	let cursor = 0;
	let changed = false;
	for (const index of sorted) {
		if (index > cursor) {
			out.push(`... (${index - cursor} lines omitted) ...`);
			changed = true;
		}
		const line = evidence.has(index) ? lines[index] : truncateLine(lines[index], opts.maxLineBytes);
		if (line !== lines[index]) changed = true;
		out.push(line);
		cursor = index + 1;
	}
	if (cursor < fromLines) {
		out.push(`... (${fromLines - cursor} lines omitted) ...`);
		changed = true;
	}

	const next = out.join("\n");
	const toBytes = utf8ByteLength(next);
	if (!changed || !hasMinimumSavings(fromBytes, toBytes, opts.minSavingsBytes, opts.minSavingsRatio)) {
		return unchangedResult(text, fromLines, fromBytes);
	}
	return { text: next, reduced: true, fromLines, toLines: out.length, fromBytes, toBytes };
}

function lineCounts(lines: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

function stripOuterEmptyLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

function extractionIsVerbatim(originalLines: readonly string[], extractedLines: readonly string[]): boolean {
	const remaining = lineCounts(originalLines);
	for (const line of extractedLines) {
		const count = remaining.get(line) ?? 0;
		if (count === 0) return false;
		remaining.set(line, count - 1);
	}
	return true;
}

function extractionPreservesOrder(originalLines: readonly string[], extractedLines: readonly string[]): boolean {
	let cursor = 0;
	for (const line of extractedLines) {
		while (cursor < originalLines.length && originalLines[cursor] !== line) cursor++;
		if (cursor >= originalLines.length) return false;
		cursor++;
	}
	return true;
}

function extractionHasEvidence(extractedLines: readonly string[], evidenceLines: readonly string[]): boolean {
	const remaining = lineCounts(extractedLines);
	for (const line of evidenceLines) {
		const count = remaining.get(line) ?? 0;
		if (count === 0) return false;
		remaining.set(line, count - 1);
	}
	return true;
}

function fallbackExtraction(
	original: string,
	reason: ExtractRejectionReason,
	options: ExtractValidationOptions,
): ExtractValidationResult {
	const additional = [
		...(options.smartOptions?.patterns ?? []),
		...(options.protectedPatterns ?? []),
	];
	const smart = reduceOutput(original, {
		...options.smartOptions,
		patterns: additional,
		minSavingsBytes: options.minSavingsBytes ?? options.smartOptions?.minSavingsBytes,
		minSavingsRatio: options.minSavingsRatio ?? options.smartOptions?.minSavingsRatio,
	});
	return {
		...smart,
		strategy: smart.reduced ? "smart" : "original",
		rejectionReason: reason,
	};
}

/**
	* Validate untrusted model extraction and choose extract, deterministic smart,
	* or original. The caller retains the original for its existing recovery path.
	*/
export function validateExtractedOutput(
	original: string,
	extracted: string,
	options: ExtractValidationOptions = {},
): ExtractValidationResult {
	const originalLines = original.split(/\r?\n/);
	const fromBytes = utf8ByteLength(original);
	const extractedLines = stripOuterEmptyLines(extracted);
	if (extractedLines.length === 0) return fallbackExtraction(original, "empty-extraction", options);
	if (!extractionIsVerbatim(originalLines, extractedLines)) return fallbackExtraction(original, "non-verbatim-line", options);
	if (!extractionPreservesOrder(originalLines, extractedLines)) return fallbackExtraction(original, "out-of-order-line", options);

	const evidence = protectedEvidenceLines(original, options.protectedPatterns);
	if (!extractionHasEvidence(extractedLines, evidence)) {
		return fallbackExtraction(original, "missing-protected-evidence", options);
	}

	const text = extractedLines.join("\n");
	const toBytes = utf8ByteLength(text);
	const minBytes = nonNegative(
		options.minSavingsBytes ?? options.smartOptions?.minSavingsBytes,
		DEFAULT_OUTPUT_OPTIONS.minSavingsBytes,
	);
	const minRatio = Math.min(1, nonNegative(
		options.minSavingsRatio ?? options.smartOptions?.minSavingsRatio,
		DEFAULT_OUTPUT_OPTIONS.minSavingsRatio,
	));
	if (extractedLines.length >= originalLines.length || !hasMinimumSavings(fromBytes, toBytes, minBytes, minRatio)) {
		return fallbackExtraction(original, "insufficient-benefit", options);
	}

	return {
		text,
		reduced: true,
		strategy: "extract",
		fromLines: originalLines.length,
		toLines: extractedLines.length,
		fromBytes,
		toBytes,
	};
}
