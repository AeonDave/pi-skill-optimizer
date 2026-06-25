/**
 * Self-contained, deterministic benchmark for pi-skill-optimizer.
 *
 *   npm run bench
 *
 * It builds a SYNTHETIC catalog (no machine data, no real skill names/paths) so
 * the numbers are reproducible and safe to publish. It measures, per `tail`
 * style, the token savings, the discovery invariants (no skill ever dropped,
 * everything stays loadable), relevance precision, behavioural-skill pinning,
 * determinism, and a fuzz pass over random/adversarial queries.
 */
import { optimize, type OptimizeConfig, type OptimizeResult } from "../src/optimize.ts";
import { normalizeProfile } from "../src/profile.ts";

const TOPICS: Record<string, string[]> = {
	crypto: ["rsa", "key", "cipher", "hash", "decrypt", "factor"],
	web: ["http", "sqli", "xss", "request", "cookie", "header"],
	python: ["python", "pytest", "module", "fixture", "typing"],
	binary: ["binary", "disassemble", "decompile", "stack", "gadget"],
	network: ["scan", "port", "packet", "dns", "subdomain"],
	cloud: ["cloud", "bucket", "iam", "container", "orchestrate"],
	forensics: ["memory", "dump", "artifact", "timeline", "registry"],
	mobile: ["android", "package", "dex", "instrument", "mobile"],
};
const PER_TOPIC = 35;
const BEHAVIOURAL = ["operator-mode", "plan-first", "verify-done", "evidence-first"];
const ROOTS = ["/syn/roots/a", "/syn/roots/b"];

function rng(seed: number): () => number {
	return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

interface Syn { name: string; description: string; location: string; root: string; topic: string; }

function buildSkills(): Syn[] {
	const rand = rng(99);
	const out: Syn[] = [];
	const sample = (toks: string[], n: number) => Array.from({ length: n }, () => toks[Math.floor(rand() * toks.length)]).join(" ");
	for (const [topic, toks] of Object.entries(TOPICS)) {
		for (let k = 0; k < PER_TOPIC; k++) {
			const name = `${topic}-${k}`;
			const description = `${topic} utility ${k}: ${sample(toks, 5)}. Use for ${topic} tasks involving ${sample(toks, 2)}.`;
			const kind = rand();
			let location: string, root: string;
			if (kind < 0.82) { root = ROOTS[Math.floor(rand() * ROOTS.length)]; location = `${root}/${name}/SKILL.md`; }
			else if (kind < 0.93) { root = "/syn/odd"; location = `/syn/odd/${name}-custom.md`; }
			else { root = ROOTS[0]; location = `${ROOTS[0]}/${name}/SKILL.md`; }
			out.push({ name, description, location, root, topic });
		}
	}
	for (const b of BEHAVIOURAL) {
		out.push({ name: b, description: `Always-on discipline that forces ${b} conduct across every session.`, location: `${ROOTS[0]}/${b}/SKILL.md`, root: ROOTS[0], topic: "_behavioural" });
	}
	return out;
}

const SKILLS = buildSkills();
const ROOT_BY_NAME = new Map(SKILLS.map((s) => [s.name, s.root] as const));
const TOTAL = SKILLS.length;

function escapeXml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function rawCatalog(): string {
	const lines = ["<available_skills>"];
	for (const s of SKILLS) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(s.name)}</name>`);
		lines.push(`    <description>${escapeXml(s.description)}</description>`);
		lines.push(`    <location>${escapeXml(s.location)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
const CATALOG = rawCatalog();
const RAW_LEN = CATALOG.length;
const tok = (c: number) => Math.round(c / 4);

const PROFILE = normalizeProfile({ critical: BEHAVIOURAL });
const BASE: OptimizeConfig = {
	mode: "hybrid", topK: 20, tail: "name",
	toolsMode: "off", toolsDropPrefixes: [], toolsTopK: 24, toolsProtect: [],
	profile: PROFILE,
};

function names(text: string): string[] {
	const out: string[] = []; const re = /<name>([\s\S]*?)<\/name>/g; let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(m[1].trim());
	return out;
}
function noteRoots(text: string): string[] {
	const m = text.match(/<skill_path_note>[\s\S]*?\(roots:\s*([\s\S]*?)\)\.?\s*Read/);
	return m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : [];
}
function loadable(text: string): number {
	const roots = noteRoots(text); let ok = 0;
	for (const block of text.split("<skill>").slice(1)) {
		const nm = block.match(/<name>([\s\S]*?)<\/name>/); if (!nm) continue;
		if (/<location>/.test(block) || roots.includes(ROOT_BY_NAME.get(nm[1].trim()) ?? "")) ok++;
	}
	return ok;
}
function runQuery(q: string, cfg: OptimizeConfig): { out: string; r: OptimizeResult } {
	const payload = { messages: [{ role: "user", content: q }], system: [{ type: "text", text: CATALOG }] };
	const r = optimize(payload, cfg);
	const sys = (r.next as { system?: Array<{ text?: string }> }).system;
	return { out: sys?.[0]?.text ?? CATALOG, r };
}

const LABELED = Object.keys(TOPICS).map((topic) => ({ topic, query: `${topic} ${TOPICS[topic].slice(0, 3).join(" ")}` }));

function evalConfig(label: string, cfg: OptimizeConfig) {
	let savedSum = 0, full = 0, present = true, minLoad = 100, behavFull = 0, precN = 0, precD = 0, recallHits = 0;
	for (const { topic, query } of LABELED) {
		const { out, r } = runQuery(query, cfg);
		savedSum += 1 - out.length / RAW_LEN;
		full += r.selected.length;
		const uniq = new Set(names(out));
		if (uniq.size !== TOTAL) present = false;
		minLoad = Math.min(minLoad, Math.round((loadable(out) / uniq.size) * 100));
		if (BEHAVIOURAL.every((b) => r.selected.includes(b))) behavFull++;
		const topicSelected = r.selected.filter((n) => n.startsWith(`${topic}-`));
		precN += topicSelected.length; precD += r.selected.filter((n) => !BEHAVIOURAL.includes(n)).length;
		if (topicSelected.length > 0) recallHits++;
	}
	const n = LABELED.length;
	return {
		label,
		savedPct: Math.round((savedSum / n) * 100),
		avgFull: Math.round(full / n),
		present,
		minLoad,
		behavFull: `${behavFull}/${n}`,
		precision: Math.round((precN / Math.max(1, precD)) * 100),
		recall: `${recallHits}/${n}`,
	};
}

console.log(`synthetic catalog: ${TOTAL} skills, raw ~${tok(RAW_LEN)} tokens (${RAW_LEN} chars)`);
console.log(`config: mode=hybrid topK=${BASE.topK}, behavioural-critical=${BEHAVIOURAL.length}\n`);

const rows = [
	evalConfig("hybrid tail=name (default)", BASE),
	evalConfig("hybrid tail=intent", { ...BASE, tail: "intent" }),
	evalConfig("compact", { ...BASE, mode: "compact" }),
];
console.log("config                       | saved | avgFull | names | load | relevance(P/recall) | behav");
console.log("-----------------------------|-------|---------|-------|------|---------------------|------");
for (const r of rows) {
	console.log(
		`${r.label.padEnd(28)} | ${`${r.savedPct}%`.padStart(5)} | ${String(r.avgFull).padStart(7)} | ${(r.present ? "100%" : "DROP").padStart(5)} | ${`${r.minLoad}%`.padStart(4)} | P=${r.precision}% rec=${r.recall}`.padEnd(20) + ` | ${r.behavFull}`,
	);
}

// determinism + idempotency
const a = runQuery("crypto rsa key", BASE).r.selected;
const b = runQuery("crypto rsa key", BASE).r.selected;
const once = runQuery("python pytest module", BASE).out;
const twice = runQuery("python pytest module", { ...BASE }).out; // re-run
const reopt = optimize({ messages: [{ role: "user", content: "x" }], system: [{ type: "text", text: once }] }, BASE);
const reoptText = (reopt.next as { system?: Array<{ text?: string }> }).system?.[0]?.text ?? once;
console.log(`\ndeterministic: ${JSON.stringify(a) === JSON.stringify(b)} | re-optimize keeps all names: ${new Set(names(reoptText)).size === TOTAL} | (idempotent stable: ${once === twice})`);

// fuzz
const VOCAB = [...new Set(SKILLS.flatMap((s) => s.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)))];
const JUNK = ["", "   ", "<script>", "&amp;", "../../x", "日本語", "🔥", "zzzz", "1234"];
const frand = rng(2025);
function fuzzQ(): string {
	const n = Math.floor(frand() * 8);
	const parts: string[] = [];
	for (let i = 0; i < n; i++) parts.push(frand() < 0.8 ? VOCAB[Math.floor(frand() * VOCAB.length)] : JUNK[Math.floor(frand() * JUNK.length)]);
	return parts.join(" ");
}
const N = 3000;
let crashes = 0, drops = 0, loadViol = 0, rangeViol = 0, behav = 0, savedSum = 0;
for (let i = 0; i < N; i++) {
	const q = fuzzQ();
	try {
		const { out, r } = runQuery(q, BASE);
		if (new Set(names(out)).size !== TOTAL) drops++;
		if (loadable(out) !== new Set(names(out)).size) loadViol++;
		const s = 1 - out.length / RAW_LEN; if (s < -1e-9 || s > 1) rangeViol++; savedSum += s;
		if (BEHAVIOURAL.every((bb) => r.selected.includes(bb))) behav++;
	} catch { crashes++; }
}
console.log(`\nfuzz ${N} queries: crashes=${crashes} drops=${drops} loadViol=${loadViol} rangeViol=${rangeViol} behavAlwaysFull=${behav}/${N - crashes} avgSaved=${Math.round((savedSum / (N - crashes)) * 100)}%`);
