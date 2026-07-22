/**
 * Deterministic blocking benchmark for tool-output safety and usefulness.
 *
 *   npm run bench:output
 */
import {
	hasMinimumSavings,
	protectedEvidenceLines,
	truncateUtf8Bytes,
	utf8ByteLength,
	validateExtractedOutput,
} from "../src/output.ts";

function hasEveryOccurrence(haystack: string, needles: readonly string[]): boolean {
	const available = new Map<string, number>();
	for (const line of haystack.split(/\r?\n/)) available.set(line, (available.get(line) ?? 0) + 1);
	for (const line of needles) {
		const count = available.get(line) ?? 0;
		if (count === 0) return false;
		available.set(line, count - 1);
	}
	return true;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

const lines = Array.from(
	{ length: 600 },
	(_, index) => `record ${index}: ${"alpha beta 漢字 🙂 ".repeat(4)}payload`,
);
lines[211] = "ERROR: compile failed at src/worker.ts:42:7";
lines[212] = "Expected: exit status 0; Actual: exit status 1";
lines[410] = "Requirement: preserve protocol version 7";
const original = lines.join("\n");
const extracted = [lines[0], lines[211], lines[212], lines[410], lines[599]].join("\n");
const options = {
	minSavingsBytes: 512,
	minSavingsRatio: 0.1,
	smartOptions: {
		maxLines: 80,
		maxBytes: 4_096,
		headLines: 8,
		tailLines: 8,
		maxLineBytes: 512,
		contextLines: 1,
	},
};

const accepted = validateExtractedOutput(original, extracted, options);
const evidence = protectedEvidenceLines(original);
const evidenceRecall = evidence.length > 0 && hasEveryOccurrence(accepted.text, evidence) ? 100 : 0;
const hallucinated = validateExtractedOutput(original, `${extracted}\nINVENTED: success`, options);
const reordered = validateExtractedOutput(
	original,
	[lines[599], lines[211], lines[212], lines[410], lines[0]].join("\n"),
	options,
);
const clipped = truncateUtf8Bytes("αβ🙂終", 10);
const unicodeSafe = utf8ByteLength(clipped) <= 10
	&& !hasUnpairedSurrogate(clipped)
	&& Buffer.from(clipped, "utf8").toString("utf8") === clipped;
const materialSavings = hasMinimumSavings(accepted.fromBytes, accepted.toBytes, 512, 0.1);
const deterministic = JSON.stringify(accepted) === JSON.stringify(validateExtractedOutput(original, extracted, options));
const savedPct = Math.round((100 * (accepted.fromBytes - accepted.toBytes)) / accepted.fromBytes);

console.log(`synthetic output: ${lines.length} lines, ${accepted.fromBytes} UTF-8 bytes`);
console.log(`accepted: strategy=${accepted.strategy}, saved=${savedPct}%, evidenceRecall=${evidenceRecall}%`);
console.log(`guards: hallucination=${hallucinated.rejectionReason}, reorder=${reordered.rejectionReason}, unicodeSafe=${unicodeSafe}, deterministic=${deterministic}`);

const invariantFailure = accepted.strategy !== "extract"
	|| evidenceRecall !== 100
	|| !materialSavings
	|| hallucinated.rejectionReason !== "non-verbatim-line"
	|| hallucinated.strategy === "extract"
	|| reordered.rejectionReason !== "out-of-order-line"
	|| reordered.strategy === "extract"
	|| !unicodeSafe
	|| !deterministic;
if (invariantFailure) process.exitCode = 1;
