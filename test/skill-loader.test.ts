import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSkillRegistry } from "../src/skill-loader.ts";

test("registry searches metadata but exact load returns no location", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-registry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const skillDir = join(root, "alpha");
	mkdirSync(skillDir);
	const file = join(skillDir, "SKILL.md");
	writeFileSync(file, "# Alpha\nFull private instructions.", "utf8");
	writeFileSync(join(skillDir, "reference.txt"), "reference body", "utf8");
	const registry = createSkillRegistry([{
		name: "alpha",
		description: "Alpha deployment workflow.",
		filePath: file,
		baseDir: root,
	}]);
	assert.deepEqual(registry.search("alpha", { pageSize: 1 }).items.map(({ name }) => name), ["alpha"]);
	const resource = registry.loadExact("alpha");
	assert.equal(resource.content, "# Alpha\nFull private instructions.");
	assert.ok(!("location" in resource));
	assert.deepEqual(registry.loadResource("alpha", "reference.txt"), {
		name: "alpha",
		relativePath: "reference.txt",
		content: "reference body",
	});
	assert.ok(!("location" in registry.loadResource("alpha", "reference.txt")));
	assert.equal(registry.locateExact("alpha").location, resolve(file));
	assert.throws(() => registry.loadExact("Alpha"), /Unknown skill name/);
	assert.throws(() => registry.loadResource("alpha", "../outside.md"), /escapes its registered base/);
	assert.throws(() => registry.loadResource("alpha", resolve(file)), /must be relative/);
});

test("registry rejects traversal outside the declared base", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-skill-traversal-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "root");
	mkdirSync(root);
	const outside = join(parent, "outside.md");
	writeFileSync(outside, "outside", "utf8");
	const registry = createSkillRegistry([{
		name: "escape",
		description: "Must not load.",
		filePath: "../outside.md",
		baseDir: root,
	}]);
	assert.throws(() => registry.loadExact("escape"), /escapes its registered base/);
	assert.throws(() => registry.locateExact("escape"), /escapes its registered base/);
});

test("registry rejects a symlink whose real target escapes the base", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-skill-symlink-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "root");
	mkdirSync(root);
	const outside = join(parent, "outside.md");
	const link = join(root, "SKILL.md");
	writeFileSync(outside, "outside", "utf8");
	try {
		symlinkSync(outside, link, "file");
	} catch (error) {
		t.skip(`file symlinks unavailable: ${String(error)}`);
		return;
	}
	const registry = createSkillRegistry([{
		name: "linked",
		description: "Must not load.",
		filePath: link,
		baseDir: root,
	}]);
	assert.throws(() => registry.loadExact("linked"), /escapes its registered base/);
});

test("registry enforces a byte cap before reading", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-size-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "SKILL.md");
	writeFileSync(file, "too large", "utf8");
	const registry = createSkillRegistry([{
		name: "large",
		description: "Large skill.",
		filePath: file,
		baseDir: root,
	}], { maxResourceBytes: 4 });
	assert.throws(() => registry.loadExact("large"), /exceeds 4 bytes/);
});
