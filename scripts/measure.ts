/**
 * Measure serialized request-size savings on a captured provider request and
 * report a deliberately approximate token equivalent.
 *
 *   node --import tsx scripts/measure.ts [path-to-captured-request.json]
 */

import { readFileSync } from "node:fs";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBody(value: unknown): JsonObject {
	let candidate = isObject(value) && "body" in value ? value.body : value;
	if (typeof candidate === "string") candidate = JSON.parse(candidate) as unknown;
	if (!isObject(candidate)) throw new Error("capture must contain a provider request object or { body: ... }");
	return candidate;
}

function toolName(value: unknown): string {
	if (!isObject(value)) return "";
	if (typeof value.name === "string") return value.name;
	return isObject(value.function) && typeof value.function.name === "string" ? value.function.name : "";
}

const capturePath = process.argv[2];
if (!capturePath) {
	console.error("usage: node --import tsx scripts/measure.ts <path-to-captured-request.json>");
	process.exit(2);
}

const body = requestBody(JSON.parse(readFileSync(capturePath, "utf8")) as unknown);
const tools = Array.isArray(body.tools) ? body.tools : [];
const estimateTokens = (chars: number) => Math.round(chars / 4);
const pct = (from: number, to: number) => from > 0 ? `${Math.round((100 * (from - to)) / from)}%` : "0%";

const OFF: OptimizeConfig = {
	mode: "off", topK: 20, tail: "name", alwaysFull: [], never: [],
	toolsMode: "off", toolsDropPrefixes: [], toolsTopK: 24, toolsProtect: [],
};

function run(overrides: Partial<OptimizeConfig>): { chars: number; removedChars: number; selected: string[]; droppedTools: string[] } {
	const { next, removedChars, selected, droppedTools } = optimize(body, { ...OFF, ...overrides });
	return { chars: JSON.stringify(next).length, removedChars, selected, droppedTools };
}

const original = JSON.stringify(body).length;
console.log(`\ncaptured provider request: ${original} serialized chars (~${estimateTokens(original)} estimated tokens)\n`);

const MCP_PREFIXES = ["htb_", "mcpwn_", "ctx_", "tavily_", "hypa_", "web_", "code_", "fetch_", "get_"];
const rows: Array<[string, ReturnType<typeof run>]> = [
	["off (baseline)", run({})],
	["skills hybrid", run({ mode: "hybrid" })],
	["+ tools drop htb_,mcpwn_", run({ mode: "hybrid", toolsMode: "drop", toolsDropPrefixes: ["htb_", "mcpwn_"] })],
	["+ tools relevance", run({ mode: "hybrid", toolsMode: "relevance", toolsTopK: 8 })],
	["all (skills+tools drop MCP)", run({ mode: "hybrid", toolsMode: "drop", toolsDropPrefixes: MCP_PREFIXES })],
];

console.log("config                       | est tok | saved | chars removed | selected | tools dropped");
console.log("-----------------------------|---------|-------|---------------|----------|--------------");
for (const [label, result] of rows) {
	console.log(`${label.padEnd(28)} | ${String(estimateTokens(result.chars)).padStart(7)} | ${pct(original, result.chars).padStart(5)} | ${String(result.removedChars).padStart(13)} | ${String(result.selected.length).padStart(8)} | ${result.droppedTools.length}`);
}

if (tools.length > 0) {
	console.log("\ntools relevance - kept non-core tools per sample query (top-8):");
	for (const query of [
		"recover a weak RSA private key",
		"enumerate a HackTheBox machine over the VPN",
		"search the web and index documentation for a library",
	]) {
		const payload = { messages: [{ role: "user", content: query }], tools };
		const { next } = optimize(payload, { ...OFF, toolsMode: "relevance", toolsTopK: 8 });
		const keptTools = isObject(next) && Array.isArray(next.tools) ? next.tools : [];
		const kept = keptTools.map(toolName).filter((name) => MCP_PREFIXES.some((prefix) => name.startsWith(prefix)));
		console.log(`  "${query}"\n    -> ${kept.join(", ") || "(none)"}`);
	}
}
