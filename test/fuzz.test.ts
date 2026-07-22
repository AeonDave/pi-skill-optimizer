import assert from "node:assert/strict";
import { test } from "node:test";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";
import { normalizeProfile } from "../src/profile.ts";

// Deterministic synthetic catalog: most skills under derivable roots, a few with
// irregular paths, a few name-only (no description). This lets the fuzz assert
// invariants without depending on the machine's installed skills.
const ROOTS = ["C:/r1/skills", "C:/r2/skills"];
const TOKENS = "rsa key crack hash smb ldap kerberos python golang rust web sqli ssrf xss apk android ghidra binary fuzz afl recon nmap scan cloud aws docker volatility memory forensic crypto research review test debug build deploy".split(" ");

function rng(seed: number): () => number {
	return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function buildCatalog(count: number): { text: string; names: Set<string>; rootByName: Map<string, string>; locByName: Map<string, string> } {
	const rand = rng(42);
	const entries: string[] = ["<available_skills>"];
	const names = new Set<string>();
	const rootByName = new Map<string, string>();
	const locByName = new Map<string, string>();
	for (let i = 0; i < count; i++) {
		const name = `skill-${i}`;
		names.add(name);
		const descWords = Array.from({ length: 4 + Math.floor(rand() * 6) }, () => TOKENS[Math.floor(rand() * TOKENS.length)]);
		const desc = `Skill ${i}: ${descWords.join(" ")}.`;
		let location: string, root: string;
		const kind = rand();
		if (kind < 0.8) {
			root = ROOTS[Math.floor(rand() * ROOTS.length)];
			location = `${root}/${name}/SKILL.md`; // derivable
		} else if (kind < 0.92) {
			root = "C:/odd";
			location = `C:/odd/custom-${i}.md`; // irregular -> explicit location kept
		} else {
			root = ROOTS[0];
			location = `${ROOTS[0]}/${name}/SKILL.md`; // name-only (no description) but derivable
		}
		rootByName.set(name, root);
		locByName.set(name, location);
		entries.push("  <skill>");
		entries.push(`    <name>${name}</name>`);
		if (kind < 0.92) entries.push(`    <description>${desc}</description>`);
		entries.push(`    <location>${location}</location>`);
		entries.push("  </skill>");
	}
	entries.push("</available_skills>");
	return { text: entries.join("\n"), names, rootByName, locByName };
}

const CAT = buildCatalog(120);

const BASE: OptimizeConfig = {
	mode: "hybrid",
	topK: 20,
	tail: "name",
	toolsMode: "off",
	toolsDropPrefixes: [],
	toolsTopK: 24,
	toolsProtect: [],
	profile: normalizeProfile({ critical: ["skill-0"] }), // behavioural/always-on stand-in
};

function namesOf(text: string): string[] {
	const out: string[] = [];
	const re = /<name>([\s\S]*?)<\/name>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(m[1].trim());
	return out;
}
function pathNoteRoots(text: string): string[] {
	const m = text.match(/<skill_path_note>[\s\S]*?\(roots:\s*([\s\S]*?)\)\.?\s*Read/);
	return m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : [];
}
function loadableCount(text: string, rootByName: Map<string, string>): number {
	const roots = pathNoteRoots(text);
	let ok = 0;
	for (const block of text.split("<skill>").slice(1)) {
		const nm = block.match(/<name>([\s\S]*?)<\/name>/);
		if (!nm) continue;
		const name = nm[1].trim();
		const hasLoc = /<location>/.test(block);
		if (hasLoc || roots.includes(rootByName.get(name) ?? "")) ok++;
	}
	return ok;
}

function fuzzQuery(rand: () => number): string {
	const n = Math.floor(rand() * 8); // 0..7 tokens (0 = empty query)
	const parts: string[] = [];
	const junk = ["", "   ", "<script>", "&amp;", "../../x", "日本語", "🔥", "zzzz", "1234"];
	for (let i = 0; i < n; i++) {
		parts.push(rand() < 0.8 ? TOKENS[Math.floor(rand() * TOKENS.length)] : junk[Math.floor(rand() * junk.length)]);
	}
	return parts.join(" ");
}

test("fuzz: 1500 random queries never drop a skill, keep everything loadable, never crash", () => {
	const rand = rng(2024);
	const total = CAT.names.size;
	let namesViol = 0, loadViol = 0, savedViol = 0, criticalViol = 0;
	const N = 1500;
	for (let i = 0; i < N; i++) {
		const q = fuzzQuery(rand);
		const payload = { messages: [{ role: "user", content: q }], system: [{ type: "text", text: CAT.text }] };
		const r = optimize(payload, BASE) as { next: { system: Array<{ text: string }> }; removedChars: number; selected: string[] };
		const out = r.next.system[0].text;
		const listed = namesOf(out);
		const unique = new Set(listed);
		if (listed.length !== total || unique.size !== total || [...CAT.names].some((name) => !unique.has(name))) namesViol++;
		if (loadableCount(out, CAT.rootByName) !== unique.size) loadViol++;
		const savedPct = 1 - out.length / CAT.text.length;
		if (savedPct < -1e-9 || savedPct > 1) savedViol++;
		if (!r.selected.includes("skill-0")) criticalViol++; // critical always full
	}
	assert.equal(namesViol, 0, "some skills were dropped from the catalog");
	assert.equal(loadViol, 0, "some skills became unloadable");
	assert.equal(savedViol, 0, "savings out of range");
	assert.equal(criticalViol, 0, "critical skill was not always kept full");
});

test("fuzz: output is deterministic for a fixed query", () => {
	const payload = () => ({ messages: [{ role: "user", content: "crack rsa key hash" }], system: [{ type: "text", text: CAT.text }] });
	const a = optimize(payload(), BASE) as { next: { system: Array<{ text: string }> } };
	const b = optimize(payload(), BASE) as { next: { system: Array<{ text: string }> } };
	assert.equal(a.next.system[0].text, b.next.system[0].text);
});

test("fuzz: re-optimizing an already-optimized catalog preserves all names (idempotent-safe)", () => {
	const once = optimize({ messages: [{ role: "user", content: "python test" }], system: [{ type: "text", text: CAT.text }] }, BASE) as { next: { system: Array<{ text: string }> } };
	const onceText = once.next.system[0].text;
	const twice = optimize({ messages: [{ role: "user", content: "python test" }], system: [{ type: "text", text: onceText }] }, BASE) as { next: { system: Array<{ text: string }> } };
	const twiceText = twice.next.system[0].text;
	assert.equal(twiceText, onceText);
	assert.deepEqual(new Set(namesOf(twiceText)), CAT.names);
	assert.equal(namesOf(twiceText).length, CAT.names.size);
	assert.equal(loadableCount(twiceText, CAT.rootByName), CAT.names.size);
});

test("never + alwaysFull behave under fuzz", () => {
	const cfg: OptimizeConfig = { ...BASE, never: ["skill-1", "skill-2*"], alwaysFull: ["skill-50"] };
	const rand = rng(7);
	for (let i = 0; i < 200; i++) {
		const q = fuzzQuery(rand);
		const payload = { messages: [{ role: "user", content: q }], system: [{ type: "text", text: CAT.text }] };
		const r = optimize(payload, cfg) as { next: { system: Array<{ text: string }> }; selected: string[] };
		const names = new Set(namesOf(r.next.system[0].text));
		assert.ok(!names.has("skill-1"), "never (exact) leaked");
		assert.ok(![...names].some((n) => n.startsWith("skill-2")), "never (prefix*) leaked");
		assert.ok(r.selected.includes("skill-50"), "alwaysFull not kept full");
	}
});
