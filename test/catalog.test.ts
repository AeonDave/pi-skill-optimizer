import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATALOG_TAGS,
	CATALOG_VERSION,
	browseSkillCatalog,
	catalogSourceHash,
	createSkillCatalogBrowser,
	normalizeCatalogMetadata,
	prepareSkillCatalog,
	renderTagDirectory,
	type CatalogMetadata,
} from "../src/catalog.ts";

const skills = [
	{ name: "design-guide", description: "Design application boundaries and data ownership." },
	{ name: "test-guide", description: "Investigate flaky tests and deterministic fixtures." },
	{ name: "unknown-guide", description: "An unusual specialist procedure. More details follow." },
];

function metadata(): CatalogMetadata {
	return {
		version: 1,
		cards: {
			"design-guide": {
				summary: "Design cohesive modules and explicit contracts.",
				tags: ["architecture", "review"],
				sourceHash: catalogSourceHash(skills[0].name, skills[0].description),
			},
			"test-guide": {
				summary: "Make flaky tests deterministic and isolated.",
				tags: ["testing", "review"],
				sourceHash: catalogSourceHash(skills[1].name, skills[1].description),
			},
		},
	};
}

test("catalog vocabulary is bounded, unique, and exposes cross-cutting methods", () => {
	assert.equal(CATALOG_VERSION, 1);
	assert.ok(CATALOG_TAGS.length >= 32 && CATALOG_TAGS.length <= 38);
	assert.equal(new Set(CATALOG_TAGS.map(({ id }) => id)).size, CATALOG_TAGS.length);
	for (const id of ["architecture", "debugging", "testing", "review", "workflow", "memory", "discipline", "other"]) {
		assert.ok(CATALOG_TAGS.some((tag) => tag.id === id && tag.description.length > 10));
	}
});

test("catalog normalization validates every card and does not read inherited fields", () => {
	const source = metadata();
	const valid = source.cards["design-guide"];
	const result = normalizeCatalogMetadata({
		version: 1,
		cards: {
			valid: { ...valid, summary: "  Design cohesive modules.  ", tags: ["review", "architecture"] },
			long: { ...valid, summary: "a".repeat(201) },
			empty: { ...valid, summary: " \t\n " },
			malformed: { ...valid, summary: "Broken \uD800 text" },
			unknown: { ...valid, tags: ["invented-topic"] },
			tooMany: { ...valid, tags: ["review", "testing", "architecture", "workflow"] },
			noTags: { ...valid, tags: [] },
			badHash: { ...valid, sourceHash: "abc" },
			inherited: Object.create(valid),
		},
	});
	assert.deepEqual(Object.keys(result?.cards ?? {}), ["valid"]);
	assert.equal(result?.cards.valid.summary, "Design cohesive modules.");
	assert.deepEqual(result?.cards.valid.tags, ["architecture", "review"]);
	assert.equal(normalizeCatalogMetadata(Object.create({ version: 1, cards: {} })), undefined);
	assert.equal(normalizeCatalogMetadata({ version: 2, cards: {} }), undefined);
	assert.equal(normalizeCatalogMetadata({ version: 1, cards: [] }), undefined);
});

test("summary validation accepts abbreviations without guessing sentence boundaries", () => {
	const card = metadata().cards["design-guide"];
	for (const summary of [
		"Supports e.g. legacy schema conversion.",
		"Clarify the interface, i.e. its inputs and outputs.",
		"Consult Dr. Example about supplied references.",
		"First sentence. Second sentence.",
	]) {
		const normalized = normalizeCatalogMetadata({ version: 1, cards: { example: { ...card, summary } } });
		assert.equal(normalized?.cards.example?.summary, summary);
	}
});

test("prototype-shaped exact names are preserved as own data without prototype mutation", () => {
	const card = metadata().cards["design-guide"];
	const result = normalizeCatalogMetadata(JSON.parse(JSON.stringify({
		version: 1,
		cards: Object.fromEntries([["__proto__", card], ["constructor", card], ["toString", card]]),
	})));
	assert.deepEqual(Object.keys(result!.cards).sort(), ["__proto__", "constructor", "toString"].sort());
	assert.equal(Object.getPrototypeOf(result!.cards), Object.prototype);
	assert.equal(Object.prototype.hasOwnProperty.call(result!.cards, "__proto__"), true);
	assert.equal(({} as Record<string, unknown>).summary, undefined);
});

test("prepared catalog retains missing, stale, and corrupt cards as source-description fallbacks", () => {
	const source = metadata();
	source.cards["test-guide"].sourceHash = "0".repeat(64);
	const prepared = prepareSkillCatalog(skills, source);
	assert.equal(prepared.total, 3);
	assert.equal(prepared.unclassified, 2);
	assert.equal(prepared.skills.find(({ name }) => name === "design-guide")?.generated, true);
	assert.deepEqual(prepared.skills.find(({ name }) => name === "test-guide"), {
		name: "test-guide", summary: skills[1].description, tags: ["unclassified"], generated: false,
	});
	assert.equal(prepared.skills.find(({ name }) => name === "unknown-guide")?.summary, "An unusual specialist procedure.");
	assert.equal(prepareSkillCatalog(skills).unclassified, 3);
	assert.equal(prepareSkillCatalog(skills, { version: 1, cards: { "design-guide": {} as never } }).unclassified, 3);
	assert.throws(() => prepareSkillCatalog([skills[0], skills[0]]), /duplicate/i);
});

test("prepared results are immutable and source/profile mutations refresh the fingerprint", () => {
	const source = metadata();
	const original = prepareSkillCatalog(skills, source);
	assert.equal(original.fingerprint, prepareSkillCatalog([...skills].reverse(), source).fingerprint);
	assert.throws(() => (original.skills[0].tags as string[]).push("testing"), TypeError);
	source.cards["design-guide"].summary = "Design services with explicit ownership.";
	assert.notEqual(original.fingerprint, prepareSkillCatalog(skills, source).fingerprint);
	assert.notEqual(original.fingerprint, prepareSkillCatalog([{ ...skills[0], description: "Different source." }, ...skills.slice(1)], metadata()).fingerprint);
	assert.equal(catalogSourceHash("café", "Unicode source."), "4c0307606f84aef33c5e838ce9191af1ccb1ef51492dce4634a81ad271246f78");
	assert.notEqual(catalogSourceHash("ab", "c"), catalogSourceHash("a", "bc"));
});

test("directory is stable, bounded, complete, and contains no individual names or paths", () => {
	const directory = renderTagDirectory(skills, metadata());
	assert.equal(directory.text, renderTagDirectory([...skills].reverse(), metadata()).text);
	assert.equal(directory.total, 3);
	assert.equal(directory.unclassified, 1);
	assert.equal(directory.usedChars, directory.text.length);
	assert.ok(directory.usedChars <= 4_000);
	assert.match(directory.text, /unclassified/);
	assert.match(directory.text, /skill_search/);
	assert.match(directory.text, /^<!--skill-optimizer:tags:v1-->/);
	for (const { id } of CATALOG_TAGS) assert.ok(directory.text.includes(`${id}\t`));
	for (const { name } of skills) assert.ok(!directory.text.includes(name));
	assert.throws(() => renderTagDirectory(skills, metadata(), directory.usedChars - 1), /budget/i);
});

test("browse supports canonical any/all filters and an explicit unclassified recovery route", () => {
	assert.deepEqual(browseSkillCatalog(skills, metadata(), { tags: ["testing", "architecture"] }).items.map(({ name }) => name), ["design-guide", "test-guide"]);
	assert.deepEqual(browseSkillCatalog(skills, metadata(), { tags: ["review", "architecture"], match: "all" }).items.map(({ name }) => name), ["design-guide"]);
	const recovery = browseSkillCatalog(skills, metadata(), { tags: ["unclassified"] });
	assert.deepEqual(recovery.items.map(({ name }) => name), ["unknown-guide"]);
	assert.equal(recovery.facets.find(({ id }) => id === "unclassified")?.count, 1);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { tags: ["unknown"] }), /unknown.*architecture/i);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { tags: Array(CATALOG_TAGS.length + 2).fill("testing") }), /tags/i);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { match: "invalid" as never }), /match/i);
});

test("explicit query ordering composes with facets without replacing source search", () => {
	const ordered = browseSkillCatalog(skills, metadata(), {
		query: "make the suite trustworthy",
		orderedNames: ["test-guide", "design-guide"],
		tags: ["review"],
	});
	assert.deepEqual(ordered.items.map(({ name }) => name), ["test-guide", "design-guide"]);
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "FLAKY" }).items[0]?.name, "test-guide");
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "no such text" }).total, 0);
	assert.equal(browseSkillCatalog(skills, metadata(), {}).total, skills.length);
});

test("tag browsing preserves the selected bucket when Japanese or Arabic queries have no lexical overlap", () => {
	for (const query of ["設計とテストを改善する", "حسّن التصميم والاختبارات"]) {
		const first = browseSkillCatalog(skills, metadata(), { tags: ["review"], query, pageSize: 1 });
		assert.equal(first.total, 2);
		assert.equal(first.items[0].name, "design-guide");
		assert.ok(first.nextCursor);
		const second = browseSkillCatalog(skills, metadata(), { tags: ["review"], query, pageSize: 1, cursor: first.nextCursor });
		assert.equal(second.items[0].name, "test-guide");
		assert.equal(second.nextCursor, undefined);
		assert.equal(browseSkillCatalog(skills, metadata(), { query }).total, 0);
	}
	const matching = browseSkillCatalog(skills, metadata(), { tags: ["review"], query: "flaky" });
	assert.deepEqual(matching.items.map(({ name }) => name), ["test-guide", "design-guide"]);
	assert.equal(matching.total, 2);
});

test("discipline and other are searchable classifications distinct from missing metadata", () => {
	const source = metadata();
	source.cards["test-guide"].tags = ["discipline", "testing"];
	source.cards["unknown-guide"] = {
		summary: "Apply a procedure outside the shared topic vocabulary.",
		tags: ["other"],
		sourceHash: catalogSourceHash(skills[2].name, skills[2].description),
	};
	const browser = createSkillCatalogBrowser(skills, source);
	assert.equal(browser.prepared.unclassified, 0);
	assert.deepEqual(browser.browse({ tags: ["discipline"] }).items.map(({ name }) => name), ["test-guide"]);
	const outside = browser.browse({ tags: ["other"] });
	assert.equal(outside.items[0].name, "unknown-guide");
	assert.equal(outside.items[0].generated, true);
	assert.equal(browser.browse({ tags: ["unclassified"] }).total, 0);
});

test("cursor is bound to cards, sources, filters, and externally supplied result order", () => {
	const options = { pageSize: 1, tags: ["review"] };
	const first = browseSkillCatalog(skills, metadata(), options);
	assert.ok(first.nextCursor);
	assert.equal(browseSkillCatalog(skills, metadata(), { ...options, cursor: first.nextCursor }).items[0].name, "test-guide");
	assert.throws(() => browseSkillCatalog(skills, metadata(), { cursor: first.nextCursor }), /cursor/i);
	const changed = metadata();
	changed.cards["design-guide"].summary = "Define data ownership across modules.";
	assert.throws(() => browseSkillCatalog(skills, changed, { ...options, cursor: first.nextCursor }), /cursor/i);
	assert.throws(() => browseSkillCatalog([{ ...skills[0], description: "Changed." }, ...skills.slice(1)], metadata(), { ...options, cursor: first.nextCursor }), /cursor/i);
	const ranked = browseSkillCatalog(skills, metadata(), { pageSize: 1, orderedNames: ["test-guide", "design-guide"] });
	assert.throws(() => browseSkillCatalog(skills, metadata(), { pageSize: 1, orderedNames: ["design-guide", "test-guide"], cursor: ranked.nextCursor }), /cursor/i);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { cursor: "garbled" }), /cursor/i);
});

test("complete browse responses stay within 3000 characters and pagination loses no cards", () => {
	const catalog = Array.from({ length: 70 }, (_, index) => ({
		name: `long-name-${String(index).padStart(3, "0")}-${"q".repeat(70)}`,
		description: `${"Long detail ".repeat(30)}ends here.`,
	}));
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = browseSkillCatalog(catalog, undefined, { pageSize: 50, cursor });
		assert.ok(page.items.length > 0);
		assert.ok(JSON.stringify(page).length <= 3_000);
		assert.equal(page.usedChars, JSON.stringify(page).length);
		names.push(...page.items.map(({ name }) => name));
		cursor = page.nextCursor;
	} while (cursor);
	assert.deepEqual(names, catalog.map(({ name }) => name));
	assert.throws(() => browseSkillCatalog([{ name: "n".repeat(4_000), description: "Valid skill." }]), /budget/i);
});

test("directory grows with count digits rather than skill count", () => {
	const make = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, description: "A particular procedure." }));
	const small = renderTagDirectory(make(355));
	const large = renderTagDirectory(make(10_000));
	assert.ok(large.usedChars <= 4_000);
	assert.ok(large.usedChars - small.usedChars < 30);
	assert.equal(large.unclassified, 10_000);
});

test("complete response budget includes every populated facet and the continuation cursor", () => {
	const catalog = CATALOG_TAGS.map(({ id }, index) => ({ name: `catalog-${String(index).padStart(2, "0")}`, description: `Source for ${id}.` }));
	const cards = Object.fromEntries(catalog.map((skill, index) => [skill.name, {
		summary: `${"A concrete distinguishing description ".repeat(5).trim()}.`,
		tags: [CATALOG_TAGS[index].id],
		sourceHash: catalogSourceHash(skill.name, skill.description),
	}]));
	const source: CatalogMetadata = { version: 1, cards };
	const first = browseSkillCatalog(catalog, source, { pageSize: 50 });
	assert.equal(first.facets.length, CATALOG_TAGS.length);
	assert.ok(first.items.length < catalog.length);
	assert.ok(first.nextCursor);
	assert.ok(first.usedChars <= 3_000);
	assert.equal(first.usedChars, JSON.stringify(first).length);
	const second = browseSkillCatalog(catalog, source, { cursor: first.nextCursor });
	assert.ok(second.usedChars <= 3_000);
	assert.notEqual(first.items[0].name, second.items[0].name);
});

test("catalog browser owns an immutable snapshot across caller source and metadata mutations", () => {
	const source = skills.map((skill) => ({ ...skill }));
	const profile = metadata();
	const browser = createSkillCatalogBrowser(source, profile);
	const before = browser.renderDirectory();
	const first = browser.browse({ pageSize: 1 });
	assert.ok(first.nextCursor);
	source[0].description = "Changed source description.";
	source[1].name = "renamed-guide";
	profile.cards["design-guide"].summary = "A newly generated description.";
	profile.cards["design-guide"].tags.push("testing");
	assert.equal(browser.renderDirectory().text, before.text);
	assert.equal(browser.browse({ query: "boundaries" }).items[0]?.name, "design-guide");
	assert.equal(browser.browse({ query: "Changed source" }).total, 0);
	assert.equal(browser.browse({ pageSize: 1, cursor: first.nextCursor }).items[0].name, "test-guide");
	assert.notEqual(createSkillCatalogBrowser(source, profile).prepared.fingerprint, browser.prepared.fingerprint);
	assert.throws(() => (browser.prepared.skills[0].tags as string[]).push("testing"), TypeError);
	assert.ok(Object.isFrozen(browser));
});

test("snapshot browser reuses prepared data and never reads caller records while paging", () => {
	let reads = 0;
	let closed = false;
	const source = Array.from({ length: 35 }, (_, index) => ({
		get name() {
			if (closed) throw new Error("caller source was revisited");
			reads += 1;
			return `snapshot-${String(index).padStart(2, "0")}`;
		},
		get description() {
			if (closed) throw new Error("caller source was revisited");
			reads += 1;
			return "Snapshot source description.";
		},
	}));
	const browser = createSkillCatalogBrowser(source);
	const prepared = browser.prepared;
	const initialReads = reads;
	closed = true;
	let cursor: string | undefined;
	const names: string[] = [];
	do {
		const page = browser.browse({ pageSize: 4, cursor });
		names.push(...page.items.map(({ name }) => name));
		cursor = page.nextCursor;
	} while (cursor);
	assert.equal(names.length, 35);
	assert.equal(new Set(names).size, 35);
	assert.equal(reads, initialReads);
	assert.equal(browser.prepared, prepared);
	assert.equal(browser.renderDirectory().fingerprint, prepared.fingerprint);
	assert.equal(browser.browse({ query: "Snapshot source" }).total, 35);
});
