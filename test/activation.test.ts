import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ACTIVATION_TASKS,
	contextualSkillNames,
	normalizeActivation,
	type SkillActivation,
} from "../src/activation.ts";

test("activation task vocabulary is a stable explicit allowlist", () => {
	assert.deepEqual(ACTIVATION_TASKS, [
		"software-design",
		"software-change",
		"software-debug",
		"software-test",
		"software-review",
		"software-read",
		"docs-write",
		"docs-review",
		"data-analysis",
		"research",
		"operations",
	]);
	assert.equal(new Set(ACTIVATION_TASKS).size, ACTIVATION_TASKS.length);
});

test("normalization keeps exact trimmed Unicode owners and only whitelisted deduplicated tags", () => {
	const input = Object.assign(Object.create({ inherited: { kind: "workflow", tasks: ["docs-write"] } }), {
		"  数据分析 🧭  ": {
			kind: "behavioral",
			tasks: ["data-analysis", "docs-write", "data-analysis", "unknown", 5],
			label: "untrusted extra field",
		},
		" software owner ": { kind: "specialist", tasks: ["software-design", "software-design", "not-a-task"] },
		"unknown kind": { kind: "persona", tasks: ["research"] },
		"empty tags": { kind: "workflow", tasks: ["nope"] },
		"   ": { kind: "workflow", tasks: ["docs-write"] },
	});
	const normalized = normalizeActivation(input);
	assert.deepEqual(normalized, {
		"数据分析 🧭": { kind: "behavioral", tasks: ["data-analysis", "docs-write"] },
		"software owner": { kind: "specialist", tasks: ["software-design"] },
	});
});

test("normalization ignores inherited/prototype data and cannot pollute the returned prototype", () => {
	const input = JSON.parse(`{
		"__proto__": {"kind":"unknown","tasks":["research"]},
		"constructor": {"kind":"workflow","tasks":["docs-write"],"extra":"ignored"},
		"safe": {"kind":"workflow","tasks":["docs-write"],"extra":"ignored"}
	}`) as Record<string, unknown>;
	const normalized = normalizeActivation(input);
	assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
	assert.equal(({} as { polluted?: boolean }).polluted, undefined);
	assert.deepEqual(normalized, {
		constructor: { kind: "workflow", tasks: ["docs-write"] },
		safe: { kind: "workflow", tasks: ["docs-write"] },
	});
});

test("contextual targets require shared tasks and workflow/behavioral kind, not kind alone", () => {
	const activation: Record<string, SkillActivation> = {
		"software-primary": { kind: "specialist", tasks: ["software-design", "software-review"] },
		"software-workflow": { kind: "workflow", tasks: ["software-review", "software-test"] },
		"software-behavior": { kind: "behavioral", tasks: ["software-design"] },
		"specialist-peer": { kind: "specialist", tasks: ["software-review"] },
		"docs-primary": { kind: "specialist", tasks: ["docs-review"] },
		"docs-review": { kind: "workflow", tasks: ["docs-review"] },
		"untagged-behavior": { kind: "behavioral", tasks: ["research"] },
	};
	assert.deepEqual(contextualSkillNames(activation, "software-primary"), [
		"software-behavior",
		"software-workflow",
	]);
	assert.deepEqual(contextualSkillNames(activation, "docs-primary"), ["docs-review"]);
	assert.ok(!contextualSkillNames(activation, "software-primary").includes("docs-review"));
	assert.ok(!contextualSkillNames(activation, "software-primary").includes("untagged-behavior"));
});

test("contextual targets sort by overlap then exact name, exclude self, and do not recurse", () => {
	const activation: Record<string, SkillActivation> = {
		primary: { kind: "workflow", tasks: ["research", "software-read"] },
		"z-one-overlap": { kind: "workflow", tasks: ["research", "operations"] },
		"b-two-overlap": { kind: "workflow", tasks: ["software-read", "research"] },
		"a-two-overlap": { kind: "behavioral", tasks: ["research", "software-read"] },
		"self-entry": { kind: "workflow", tasks: ["research"] },
		"transitive-only": { kind: "behavioral", tasks: ["operations"] },
	};
	assert.deepEqual(contextualSkillNames(activation, "primary"), [
		"a-two-overlap",
		"b-two-overlap",
		"self-entry",
		"z-one-overlap",
	]);
	assert.ok(!contextualSkillNames(activation, "primary").includes("primary"));
	assert.ok(!contextualSkillNames(activation, "primary").includes("transitive-only"));
	assert.deepEqual(contextualSkillNames(activation, "self-entry"), ["a-two-overlap", "b-two-overlap", "primary", "z-one-overlap"]);
});

test("contextual lookup safely returns empty for missing or malformed activation", () => {
	assert.deepEqual(contextualSkillNames(undefined, "primary"), []);
	assert.deepEqual(contextualSkillNames({}, "primary"), []);
	assert.deepEqual(contextualSkillNames({ toString: { kind: "workflow", tasks: ["research"] } } as unknown as Record<string, SkillActivation>, "toString"), []);
	assert.deepEqual(contextualSkillNames({ primary: { kind: "specialist", tasks: [] } }, "primary"), []);
	assert.deepEqual(contextualSkillNames({ primary: { kind: "specialist", tasks: ["research"] } }, "missing"), []);
});
