import assert from "node:assert/strict";
import test from "node:test";
import {
	assertValidCorpusV1,
	createCatalogExampleV1,
	createOutputExampleV1,
	createPrivateCorpusV1,
	createSkillExampleV1,
	evidenceRecall,
	redactSensitiveText,
	renderAvailableSkills,
	sanitizeCatalogSkills,
	stableCorpusId,
	validateCorpusV1,
} from "../src/corpus.ts";

const SALT = "private-corpus-test-salt-v1";

test("stableCorpusId is keyed, deterministic and object-order independent", () => {
	const first = stableCorpusId(SALT, "catalog", { z: 2, a: [1, "x"] });
	const second = stableCorpusId(SALT, "catalog", { a: [1, "x"], z: 2 });
	assert.equal(first, second);
	assert.match(first, /^catalog_[0-9a-f]{32}$/);
	assert.notEqual(first, stableCorpusId("different-private-salt-v1", "catalog", { a: [1, "x"], z: 2 }));
	assert.notEqual(first, stableCorpusId(SALT, "output", { a: [1, "x"], z: 2 }));
	assert.throws(() => stableCorpusId("short", "catalog", "value"), /at least 16/);
});

test("redactSensitiveText removes common PII, paths and secret forms without a mapping", () => {
	const input = [
		"owner=user@example.com ip=192.168.10.42",
		"home=/home/alice/private/project other=C:\\Users\\Alice\\work\\secret.txt",
		"absolute=/opt/company/service/config.json unc=\\\\server\\share\\private\\file.txt",
		"url=https://alice:password@example.internal:8443/private?q=1",
		"uuid=123e4567-e89b-42d3-a456-426614174000",
		"jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
		"api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
		"-----BEGIN PRIVATE KEY-----\nsecretmaterial\n-----END PRIVATE KEY-----",
		// Unicode is intentional: redaction must preserve non-sensitive content.
		"message=caffe \u6f22\u5b57 \ud83d\ude80",
	].join("\n");
	const redacted = redactSensitiveText(input);
	for (const secret of [
		"user@example.com",
		"192.168.10.42",
		"/home/alice",
		"C:\\Users\\Alice",
		"/opt/company/service/config.json",
		"example.internal",
		"123e4567-e89b-42d3-a456-426614174000",
		"eyJhbGciOiJIUzI1NiJ9",
		"abcdefghijklmnopqrstuvwxyz012345",
		"secretmaterial",
	]) assert.equal(redacted.includes(secret), false, secret);
	assert.match(redacted, /<EMAIL>/);
	assert.match(redacted, /<IPV4>/);
	assert.match(redacted, /<HOME>/);
	assert.match(redacted, /<ABS_PATH>/);
	assert.match(redacted, /https:\/\/<URL_HOST>:8443/);
	assert.match(redacted, /<UUID>/);
	assert.match(redacted, /<JWT>/);
	assert.match(redacted, /<API_TOKEN>/);
	assert.match(redacted, /<PEM_SECRET>/);
	assert.match(redacted, /caffe \u6f22\u5b57 \ud83d\ude80/);
	assert.equal(redactSensitiveText(redacted), redacted);
});

test("catalog sanitization preserves skill semantics and assigns stable root placeholders", () => {
	const raw = [
		{
			name: "betaSkill",
			description: "Handles beta workflows for user@example.com.",
			location: "D:\\Private\\skills\\betaSkill\\SKILL.md",
		},
		{
			name: "alpha-tool",
			description: "Use for alpha <analysis> & diagnostics.",
			location: "/home/alice/.agents/skills/alpha-tool/SKILL.md",
		},
	];
	const sanitized = sanitizeCatalogSkills(raw);
	assert.deepEqual(sanitized.map((skill) => skill.name), ["betaSkill", "alpha-tool"]);
	assert.equal(sanitized[0]?.location, "<ROOT_2>/betaSkill/SKILL.md");
	assert.equal(sanitized[1]?.location, "<ROOT_1>/alpha-tool/SKILL.md");
	assert.equal(sanitized[0]?.description.includes("user@example.com"), false);

	const rendered = renderAvailableSkills(sanitized);
	assert.match(rendered, /^<available_skills>/);
	assert.match(rendered, /<name>betaSkill<\/name>/);
	assert.match(rendered, /<location>&lt;ROOT_1&gt;\/alpha-tool\/SKILL.md<\/location>/);
	assert.match(rendered, /alpha &lt;analysis&gt; &amp; diagnostics/);
	assert.match(rendered, /<\/available_skills>$/);
});

test("factories produce a valid schema-v1 corpus without raw private values", () => {
	const catalog = createCatalogExampleV1({
		label: "local catalog",
		skills: [{
			name: "githubAddressComments",
			description: "Resolve review comments for dev@example.com.",
			location: "/Users/developer/.agents/skills/githubAddressComments/SKILL.md",
		}],
	}, SALT);
	const skill = createSkillExampleV1({
		label: "review routing",
		catalogId: catalog.id,
		query: "Address review comments from https://git.example.internal/pull/7",
		relevantSkillNames: ["githubAddressComments"],
	}, SALT);
	const output = createOutputExampleV1({
		label: "failing command",
		tool: "bash",
		text: "start\nERROR dev@example.com failed at /home/dev/project/src/app.ts:42\nend",
		evidence: ["ERROR dev@example.com failed at /home/dev/project/src/app.ts:42"],
	}, SALT);
	const corpus = createPrivateCorpusV1([catalog], [skill], [output]);
	assert.doesNotThrow(() => assertValidCorpusV1(corpus));
	assert.equal(JSON.stringify(corpus).includes("example.internal"), false);
	assert.equal(JSON.stringify(corpus).includes("dev@example.com"), false);
	assert.equal(JSON.stringify(corpus).includes("/home/dev"), false);
});

test("validation rejects duplicate IDs, missing labels and raw private content", () => {
	const corpus = {
		schemaVersion: 1,
		catalogs: [{
			id: "catalog_duplicate",
			label: "",
			skills: [{ name: "safe-skill", description: "owner@example.com", location: "<ROOT_1>/safe-skill/SKILL.md" }],
		}],
		skillExamples: [],
		outputExamples: [{
			id: "catalog_duplicate",
			label: "output",
			tool: "bash",
			text: "ordinary output",
			evidence: ["ERROR missing"],
		}],
	};
	const result = validateCorpusV1(corpus);
	assert.equal(result.valid, false);
	const codes = new Set(result.issues.map((entry) => entry.code));
	assert.equal(codes.has("missing-label"), true);
	assert.equal(codes.has("duplicate-id"), true);
	assert.equal(codes.has("unsafe-content"), true);
	assert.equal(codes.has("missing-evidence"), true);
	assert.throws(() => assertValidCorpusV1(corpus), /invalid private corpus/);
});

test("evidenceRecall accounts for repeated occurrences", () => {
	const partial = evidenceRecall(["ERROR x", "ERROR x", "WARN y"], "start\nERROR x\nWARN y\nend");
	assert.deepEqual(partial, {
		expected: 3,
		matched: 2,
		recall: 2 / 3,
		missing: ["ERROR x"],
		complete: false,
	});
	const complete = evidenceRecall(["ERROR x", "ERROR x", "WARN y"], ["ERROR x", "WARN y", "ERROR x"]);
	assert.equal(complete.recall, 1);
	assert.equal(complete.complete, true);
	assert.deepEqual(complete.missing, []);
});
