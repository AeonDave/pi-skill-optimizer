/** Slice original text offsets, retaining every selected line's original terminator. */
export function sliceOutputLines(text: string, startLine = 1, lineCount = 200): {
	text: string; startLine: number; lineCount: number; totalLines: number;
} {
	if (!Number.isSafeInteger(startLine) || startLine < 1) {
		throw new RangeError("startLine must be a positive safe integer");
	}
	if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 1000) {
		throw new RangeError("lineCount must be an integer from 1 to 1000");
	}
	const starts = [0];
	for (const match of text.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length);
	const totalLines = starts.length;
	if (startLine > totalLines) return { text: "", startLine, lineCount: 0, totalLines };
	const count = Math.min(lineCount, totalLines - startLine + 1);
	const from = starts[startLine - 1];
	const to = starts[startLine - 1 + count] ?? text.length;
	return { text: text.slice(from, to), startLine, lineCount: count, totalLines };
}
