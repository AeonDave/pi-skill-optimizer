import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExtractPrompt, commandProgram, isExcludedCommand, isRtkSource, mergeExtracted, reduceOutput, signalLines } from "../src/output.ts";

test("small output is returned unchanged", () => {
	const text = "line1\nline2\nline3";
	const r = reduceOutput(text, { maxLines: 200, maxBytes: 16000 });
	assert.equal(r.reduced, false);
	assert.equal(r.text, text);
});

test("large output keeps head, tail, and elides the middle with a counted marker", () => {
	const lines = Array.from({ length: 500 }, (_, i) => `ok line ${i}`);
	const r = reduceOutput(lines.join("\n"), { maxLines: 100, headLines: 10, tailLines: 10 });
	assert.equal(r.reduced, true);
	assert.ok(r.toLines < r.fromLines);
	assert.ok(r.text.includes("ok line 0")); // head kept
	assert.ok(r.text.includes("ok line 499")); // tail kept
	assert.ok(/\(\d+ lines omitted\)/.test(r.text)); // counted elision
});

test("error and warning lines survive even when buried in the middle", () => {
	const lines = Array.from({ length: 400 }, (_, i) => `step ${i} ok`);
	lines[200] = "ERROR: boom in module X";
	lines[250] = "Warning: deprecated API Y";
	lines[300] = "  at fn (file.ts:10:5)"; // stack frame
	const r = reduceOutput(lines.join("\n"), { maxLines: 50, headLines: 5, tailLines: 5 });
	assert.equal(r.reduced, true);
	assert.ok(r.text.includes("ERROR: boom in module X"));
	assert.ok(r.text.includes("Warning: deprecated API Y"));
	assert.ok(r.text.includes("at fn (file.ts:10:5)"));
});

test("giant single line is truncated with a char marker", () => {
	const giant = "x".repeat(50_000);
	const r = reduceOutput(`head\n${giant}\nERROR: tail`, { maxLines: 1, maxBytes: 100, maxLineBytes: 100 });
	assert.equal(r.reduced, true);
	assert.ok(/\+\d+ chars/.test(r.text));
	assert.ok(r.text.includes("ERROR: tail")); // signal still kept
});

test("CRLF input is handled (cross-OS)", () => {
	const lines = Array.from({ length: 300 }, (_, i) => `row ${i}`);
	const r = reduceOutput(lines.join("\r\n"), { maxLines: 50, headLines: 5, tailLines: 5 });
	assert.equal(r.reduced, true);
	assert.ok(r.text.includes("row 0"));
	assert.ok(r.text.includes("row 299"));
});

test("reduction is a no-op when it would not actually shrink", () => {
	// few lines but over a tiny byte threshold, yet every line is a signal line -> kept -> no shrink
	const text = "ERROR a\nERROR b\nERROR c";
	const r = reduceOutput(text, { maxLines: 1, maxBytes: 1, headLines: 0, tailLines: 0 });
	assert.equal(r.reduced, false);
	assert.equal(r.text, text);
});

test("isRtkSource detects an rtk extension by path/source/name, not unrelated ones", () => {
	assert.equal(isRtkSource("rtk", "C:/Users/x/.pi/agent/extensions/pi-rtk-optimizer/index.ts", ""), true);
	assert.equal(isRtkSource("", "", "npm:pi-rtk-optimizer"), true);
	assert.equal(isRtkSource("rtk", "", ""), true);
	assert.equal(isRtkSource("skill-optimizer", "/x/pi-skill-optimizer/index.ts", ""), false);
	assert.equal(isRtkSource("network", "", ""), false); // 'rtk' not a standalone word
});

test("commandProgram resolves the program name (env assigns, sudo, paths, .exe)", () => {
	assert.equal(commandProgram("cat big.txt"), "cat");
	assert.equal(commandProgram("  FOO=1 BAR=2 ls -la /tmp"), "ls");
	assert.equal(commandProgram("sudo find / -name x"), "find");
	assert.equal(commandProgram("/usr/bin/head -n 5 f"), "head");
	assert.equal(commandProgram("C:\\\\Windows\\\\System32\\\\tree.exe"), "tree");
	assert.equal(commandProgram("npm test"), "npm");
});

test("isExcludedCommand matches pure-dump programs, not selections", () => {
	const exclude = ["cat", "ls", "head", "tail", "tree", "find"];
	assert.equal(isExcludedCommand("cat config.txt", exclude), true);
	assert.equal(isExcludedCommand("FOO=1 ls -la", exclude), true);
	assert.equal(isExcludedCommand("grep -rn token src/", exclude), false); // selection -> extract still applies
	assert.equal(isExcludedCommand("npm test", exclude), false);
	assert.equal(isExcludedCommand("cat x", []), false); // empty list disables
});

test("signalLines collects error/warning/stack lines verbatim", () => {
	const text = "ok 1\nERROR: boom\nok 2\nWarning: deprecated\n  at fn (a.ts:1:2)\nok 3";
	const sig = signalLines(text);
	assert.ok(sig.includes("ERROR: boom"));
	assert.ok(sig.includes("Warning: deprecated"));
	assert.ok(sig.some((l) => l.includes("at fn (a.ts:1:2)")));
	assert.ok(!sig.includes("ok 1"));
});

test("buildExtractPrompt embeds request+command, forbids prose, caps output", () => {
	const { system, user } = buildExtractPrompt("find the failing test", "npm test", "x".repeat(100_000), 1000);
	assert.ok(/EXTRACT|SELECT/.test(system));
	assert.ok(/no prose/i.test(system));
	assert.ok(user.includes("find the failing test"));
	assert.ok(user.includes("npm test"));
	assert.ok(user.includes("truncated for extraction")); // input capped
});

test("mergeExtracted guarantees missing signal lines are prepended verbatim", () => {
	const extracted = "relevant line A\nrelevant line B";
	const merged = mergeExtracted(extracted, ["ERROR: critical boom", "relevant line A"]);
	assert.ok(merged.includes("ERROR: critical boom")); // missing signal added
	assert.ok(merged.includes("relevant line A")); // not duplicated awkwardly, still present
	assert.ok(merged.indexOf("ERROR: critical boom") < merged.indexOf("relevant line B")); // signal first
});

test("deterministic for identical input", () => {
	const lines = Array.from({ length: 600 }, (_, i) => `n ${i}`);
	const a = reduceOutput(lines.join("\n"), { maxLines: 100 });
	const b = reduceOutput(lines.join("\n"), { maxLines: 100 });
	assert.equal(a.text, b.text);
});
