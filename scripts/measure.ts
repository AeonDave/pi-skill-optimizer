/**
 * Measure real token savings on a captured request body (system prompt + tools),
 * and show that ranking selects sensible skills/tools per query.
 *
 *   node --import tsx scripts/measure.ts [path-to-captured-request.json]
 */

import { readFileSync } from "node:fs";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";

const capturePath = process.argv[2];
if (!capturePath) {
	console.error("usage: node --import tsx scripts/measure.ts <path-to-captured-request.json>");
	process.exit(2);
}
const body = JSON.parse(readFileSync(capturePath, "utf8")).body as {
	system?: unknown;
	tools?: unknown;
};

const systemText = Array.isArray(body.system)
	? body.system.map((b: { text?: string }) => b?.text ?? "").join("")
	: String(body.system ?? "");
const tools = Array.isArray(body.tools) ? body.tools : [];

const QUERY = "recover a weak RSA private key from n, e and ciphertext";
const tok = (chars: number) => Math.round(chars / 4);
const pct = (from: number, to: number) => `${Math.round((100 * (from - to)) / from)}%`;

const OFF: OptimizeConfig = {
	mode: "off", topK: 16, adaptiveTopK: true, minTopK: 8, maxTopK: 24, tailChars: 0, safeFallbackTailChars: 80, keepLocations: false, extraStripTags: [], dropAnchors: [],
	toolsMode: "off", toolsDropPrefixes: [], toolsTopK: 24, toolsProtect: [],
};

function run(overrides: Partial<OptimizeConfig>): { chars: number; selected: string[]; droppedTools: string[] } {
	const payload = { messages: [{ role: "user", content: QUERY }], system: [{ type: "text", text: systemText }], tools };
	const { next, selected, droppedTools } = optimize(payload, { ...OFF, ...overrides }) as {
		next: { system: Array<{ text: string }>; tools: unknown[] };
		selected: string[];
		droppedTools: string[];
	};
	const chars = next.system[0].text.length + JSON.stringify(next.tools).length;
	return { chars, selected, droppedTools };
}

const original = systemText.length + JSON.stringify(tools).length;
console.log(`\ncaptured request (system + ${tools.length} tools): ${original} chars (~${tok(original)} tokens)\n`);

const MCP_PREFIXES = ["htb_", "mcpwn_", "ctx_", "tavily_", "hypa_", "web_", "code_", "fetch_", "get_"];
const rows: Array<[string, ReturnType<typeof run>]> = [
	["off (baseline)", run({})],
	["skills hybrid", run({ mode: "hybrid" })],
	["+ tools drop htb_,mcpwn_", run({ mode: "hybrid", toolsMode: "drop", toolsDropPrefixes: ["htb_", "mcpwn_"] })],
	["+ tools relevance", run({ mode: "hybrid", toolsMode: "relevance", toolsTopK: 8 })],
	["all (skills+tools drop MCP)", run({ mode: "hybrid", toolsMode: "drop", toolsDropPrefixes: MCP_PREFIXES })],
];

console.log("config                       | ~tokens | saved | tools dropped");
console.log("-----------------------------|---------|-------|--------------");
for (const [label, r] of rows) {
	console.log(`${label.padEnd(28)} | ${String(tok(r.chars)).padStart(7)} | ${pct(original, r.chars).padStart(5)} | ${r.droppedTools.length}`);
}

console.log("\ntools relevance — kept non-core tools per query (top-8):");
for (const q of [
	"recover a weak RSA private key",
	"enumerate a HackTheBox machine over the VPN",
	"search the web and index documentation for a library",
]) {
	const payload = { messages: [{ role: "user", content: q }], system: [{ type: "text", text: "" }], tools };
	const { next } = optimize(payload, { ...OFF, toolsMode: "relevance", toolsTopK: 8 }) as { next: { tools: Array<{ name: string }> } };
	const kept = next.tools.map((t) => t.name).filter((n) => MCP_PREFIXES.some((p) => n.startsWith(p)));
	console.log(`  "${q}"\n    → ${kept.join(", ") || "(none)"}`);
}
