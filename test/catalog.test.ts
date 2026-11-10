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
	// The directory lists populated rows only (see the zero-count test below), so
	// assert against the facets this catalog really exposes instead of the vocabulary.
	for (const { id } of prepareSkillCatalog(skills, metadata()).facets) assert.ok(directory.text.includes(`${id}\t`));
	for (const { name } of skills) assert.ok(!directory.text.includes(name));
	assert.throws(() => renderTagDirectory(skills, metadata(), directory.usedChars - 1), /budget/i);
});

test("browse supports canonical any/all filters and an explicit unclassified recovery route", () => {
	assert.deepEqual(browseSkillCatalog(skills, metadata(), { tags: ["testing", "architecture"] }).items.map(({ name }) => name), ["design-guide", "test-guide"]);
	assert.deepEqual(browseSkillCatalog(skills, metadata(), { tags: ["review", "architecture"], match: "all" }).items.map(({ name }) => name), ["design-guide"]);
	const recovery = browseSkillCatalog(skills, metadata(), { tags: ["unclassified"] });
	assert.deepEqual(recovery.items.map(({ name }) => name), ["unknown-guide"]);
	assert.equal(recovery.facets?.find(({ id }) => id === "unclassified")?.count, 1);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { tags: ["unknown"] }), /unknown.*architecture/i);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { tags: Array(CATALOG_TAGS.length + 2).fill("testing") }), /tags/i);
	assert.throws(() => browseSkillCatalog(skills, metadata(), { match: "invalid" as never }), /match/i);
});

// Pins the documented full-browse contract: a non-empty query without `orderedNames`
// returns the complete catalog in canonical order, because the browser never matches
// text itself. The wired skill_search path always supplies that BM25F order, so the
// tool still abstains (total: 0) when the ranker reports no signal.
test("a query without orderedNames is a full canonical browse while supplied ordering is the only lexical source", () => {
	const ordered = browseSkillCatalog(skills, metadata(), {
		query: "make the suite trustworthy",
		orderedNames: ["test-guide", "design-guide"],
		tags: ["review"],
	});
	assert.deepEqual(ordered.items.map(({ name }) => name), ["test-guide", "design-guide"]);
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "FLAKY", orderedNames: ["test-guide"] }).items[0]?.name, "test-guide");
	// Contract, not an accident: the browser performs no text matching of its own, so a
	// raw query without a supplied ordering is a full canonical browse of every card. It
	// can neither narrow the catalog nor invent a rank; the wired resolver always passes
	// `orderedNames`, so the tool path still abstains when the ranker finds no signal.
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "FLAKY" }).total, skills.length);
	assert.deepEqual(browseSkillCatalog(skills, metadata(), { query: "FLAKY" }).items.map(({ name }) => name), ["design-guide", "test-guide", "unknown-guide"]);
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "no such text", orderedNames: [] }).total, 0);
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
		// Without a tag bucket there is no bucket to order, and the browser does not
		// substitute its own substring matcher: the whole catalog stays available.
		assert.equal(browseSkillCatalog(skills, metadata(), { query }).total, skills.length);
	}
	// The wired path supplies the BM25F order, which puts the matching card first.
	const matching = browseSkillCatalog(skills, metadata(), { tags: ["review"], query: "flaky", orderedNames: ["test-guide", "design-guide"] });
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
	// Provenance stays in the prepared snapshot; the wire card never carries it.
	assert.equal(browser.prepared.skills.find(({ name }) => name === "unknown-guide")?.generated, true);
	assert.deepEqual(Object.keys(outside.items[0]), ["name", "summary", "tags"]);
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
	assert.equal(first.facets!.length, CATALOG_TAGS.length);
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
	// The snapshot keeps the pre-mutation names and text: ordering is resolved against
	// the captured cards, never against the caller records mutated above.
	assert.equal(browser.browse({ query: "boundaries", orderedNames: ["design-guide"] }).items[0]?.name, "design-guide");
	assert.equal(browser.browse({ orderedNames: ["renamed-guide"] }).total, 0);
	assert.equal(browser.browse({ orderedNames: ["test-guide"] }).items[0]?.name, "test-guide");
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
	assert.equal(browser.browse({ query: "Snapshot source", orderedNames: names }).total, 35);
});

test("tagged browse appends off-bucket lexical matches as a rescue tail", () => {
	const options = {
		tags: ["testing"],
		query: "unusual specialist procedure",
		// index.ts supplies only the BM25F-matched names, never a padded union with the
		// whole catalog: listed bucket matches come first, then the remaining bucket
		// members in canonical order, then off-bucket matches as the rescue tail. A
		// rescue card inside the ranker's overall top 3 is promoted into that head.
		orderedNames: ["unknown-guide", "test-guide", "design-guide"],
	};
	const page = browseSkillCatalog(skills, metadata(), options);
	// unknown-guide (rank 0) and design-guide (rank 2) are both inside the top 3, so the
	// head is the overall rank order with the bucket member kept in it.
	assert.deepEqual(page.items.map(({ name }) => name), ["unknown-guide", "test-guide", "design-guide"]);
	assert.deepEqual(page.items.map(({ rescue }) => rescue ?? false), [true, false, true]);
	// The semantic bucket stays first; facets describe that bucket, never the tail.
	assert.deepEqual(page.facets!.map(({ id }) => id), ["testing", "review"]);
	assert.equal(page.total, 3);
	const first = browseSkillCatalog(skills, metadata(), { ...options, pageSize: 1 });
	assert.equal(first.items[0].name, "unknown-guide");
	assert.equal(first.items[0].rescue, true);
	assert.equal(first.total, 3);
	assert.deepEqual(first.facets!.map(({ id }) => id), ["testing", "review"]);
	assert.ok(first.nextCursor);
	const second = browseSkillCatalog(skills, metadata(), { ...options, pageSize: 1, cursor: first.nextCursor });
	assert.equal(second.items[0].name, "test-guide");
	assert.equal(second.facets, undefined, "facets are first-page-only");
	assert.ok(second.nextCursor);
	const third = browseSkillCatalog(skills, metadata(), { ...options, pageSize: 1, cursor: second.nextCursor });
	assert.equal(third.items[0].name, "design-guide");
	assert.equal(third.nextCursor, undefined);
	// The selected bucket stays complete even when the query matched few of its
	// cards: unlisted bucket members follow the matched ones in canonical order.
	const completed = browseSkillCatalog(skills, metadata(), {
		tags: ["review"],
		query: "unusual specialist procedure",
		orderedNames: ["unknown-guide", "test-guide"],
	});
	assert.deepEqual(completed.items.map(({ name }) => name), ["unknown-guide", "test-guide", "design-guide"]);
	assert.deepEqual(completed.facets!.map(({ id }) => id), ["architecture", "testing", "review"]);
	assert.equal(completed.total, 3);
	// Without tags the supplied order is lexical filtering: no catalog completion,
	// because that would defeat the ranker's abstention.
	assert.deepEqual(
		browseSkillCatalog(skills, metadata(), { orderedNames: ["unknown-guide"] }).items.map(({ name }) => name),
		["unknown-guide"],
	);
	assert.equal(browseSkillCatalog(skills, metadata(), { query: "expected zero matches", orderedNames: [] }).total, 0);
});

test("directory lists only populated tag rows and keeps the unclassified header", () => {
	const directory = renderTagDirectory(skills, metadata());
	const prepared = prepareSkillCatalog(skills, metadata());
	const populated = prepared.facets.map(({ id }) => id);
	assert.deepEqual(populated, ["architecture", "testing", "review", "unclassified"]);
	const lines = directory.text.split("\n");
	const header = lines.indexOf("tag\tdescription\tcount");
	assert.ok(header > 0);
	assert.deepEqual(lines.slice(header + 1, -1), [
		"architecture\tSystem structure, boundaries, and design decisions\t1",
		"testing\tTests, fixtures, fuzzing, and test reliability\t1",
		"review\tAssess existing work and identify concrete issues\t2",
		"unclassified\tMissing or stale metadata; source-description cards remain available\t1",
	]);
	for (const { id } of CATALOG_TAGS) {
		if (populated.includes(id)) continue;
		assert.ok(!directory.text.includes(`${id}\t`), `zero-count row ${id} must be dropped`);
	}
	// Counts stay authoritative in the header even when no row is emitted for them.
	assert.match(directory.text, /total="3" unclassified="1"/);
	const noCards = renderTagDirectory([{ name: "plain", description: "No card at all." }]);
	assert.match(noCards.text, /unclassified="1"/);
	assert.equal(noCards.unclassified, 1);
	const empty = renderTagDirectory([]);
	assert.match(empty.text, /total="0" unclassified="0"/);
	assert.equal(empty.text.split("\n").indexOf("tag\tdescription\tcount") + 1, empty.text.split("\n").length - 1, "no rows");
	assert.ok(empty.usedChars < directory.usedChars, "dropping zero-count rows shrinks the prompt block");
});

test("malformed skill sources are quarantined instead of disabling the catalog", () => {
	const malformed = [
		null,
		{ name: "  spaced-guide ", description: "Untrimmed name." },
		{ name: "nameless-guide" },
		{ name: "broken-guide", description: "Lone surrogate \uD800 text." },
	] as unknown as { name: string; description: string }[];
	const sources = [skills[0], ...malformed, skills[1], skills[2]];
	const prepared = prepareSkillCatalog(sources, metadata());
	assert.equal(prepared.total, 3);
	assert.deepEqual(prepared.skills.map(({ name }) => name), ["design-guide", "test-guide", "unknown-guide"]);
	assert.deepEqual(prepared.quarantined.map(({ index, name }) => [index, name]), [
		[1, null],
		[2, "  spaced-guide "],
		[3, "nameless-guide"],
		[4, "broken-guide"],
	]);
	assert.ok(prepared.quarantined.every(({ reason }) => /Skill source/.test(reason)));
	assert.ok(Object.isFrozen(prepared.quarantined[0]));
	// Skipping is diagnostic, not silent: the directory reports it and keeps counts.
	const directory = renderTagDirectory(sources, metadata());
	assert.equal(directory.quarantined, 4);
	assert.equal(directory.total, 3);
	assert.equal(directory.fingerprint, prepared.fingerprint);
	// A quarantined run must never reuse a cached clean prepared catalog.
	assert.equal(prepareSkillCatalog([skills[0], skills[1], skills[2]], metadata()).quarantined.length, 0);
	assert.equal(prepareSkillCatalog([skills[0], skills[1], skills[2]], metadata()).total, 3);
	assert.deepEqual(browseSkillCatalog(sources, metadata()).items.map(({ name }) => name), ["design-guide", "test-guide", "unknown-guide"]);
	// Duplicate valid names stay a host error rather than a silent quarantine.
	assert.throws(() => prepareSkillCatalog([skills[0], skills[0]]), /duplicate/i);
});

// ---- Wire shape: Q1a compact envelope, Q2 bounded rescue promotion, Q1b rest ----

function diet(count: number, summary = "Short note.") {
	const list = Array.from({ length: count }, (_, index) => ({ name: `diet-${String(index).padStart(3, "0")}`, description: summary }));
	const source: CatalogMetadata = { version: 1, cards: Object.fromEntries(list.map(({ name, description }) => [name, {
		summary: description, tags: ["review"], sourceHash: catalogSourceHash(name, description),
	}])) };
	return { list, source };
}

test("browse envelope is compact: no version or fingerprint, three-key cards, first-page facets", () => {
	const page = browseSkillCatalog(skills, metadata(), { tags: ["review"] });
	assert.deepEqual(Object.keys(page), ["total", "items", "facets", "usedChars"]);
	assert.equal("version" in page, false);
	assert.equal("fingerprint" in page, false);
	for (const item of page.items) assert.deepEqual(Object.keys(item), ["name", "summary", "tags"]);
	assert.ok(page.facets!.every((facet) => Object.keys(facet).join(",") === "id,count"));
	assert.equal(page.usedChars, JSON.stringify(page).length);

	const first = browseSkillCatalog(skills, metadata(), { tags: ["review"], pageSize: 1 });
	const cursor = first.nextCursor!;
	assert.ok(cursor.length <= 64, `cursor must stay compact, got ${cursor.length} characters`);
	const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body), ["o", "s"], "the cursor carries only the offset and its signature");
	assert.equal(body.o, 1);
	assert.equal(typeof body.s, "string");
	assert.equal((body.s as string).length, 16);

	const next = browseSkillCatalog(skills, metadata(), { tags: ["review"], pageSize: 1, cursor });
	assert.deepEqual(Object.keys(next), ["total", "items", "usedChars"]);
	assert.equal(next.facets, undefined, "facets are first-page-only");
	// The signature binds catalog, filter and offset, so an edited cursor is rejected.
	const forged = Buffer.from(JSON.stringify({ ...body, o: 0 }), "utf8").toString("base64url");
	assert.throws(() => browseSkillCatalog(skills, metadata(), { tags: ["review"], pageSize: 1, cursor: forged }), /cursor/i);
});

test("default page size is the cap for tag and empty browses and stays 10 for query-only search", () => {
	const { list, source } = diet(60);
	assert.ok(browseSkillCatalog(list, source, { tags: ["review"] }).items.length > 10, "tag browse pages at the cap");
	assert.ok(browseSkillCatalog(list, source, {}).items.length > 10, "empty browse pages at the cap");
	const lexical = browseSkillCatalog(list, source, { query: "short note", orderedNames: list.map(({ name }) => name) });
	assert.equal(lexical.items.length, 10, "query-only lexical search keeps the old page size");
	// The cap is enforced, not merely defaulted: a larger request cannot exceed it.
	const clamped = browseSkillCatalog(list, source, { tags: ["review"], pageSize: 500 });
	assert.equal(clamped.items.length, browseSkillCatalog(list, source, { tags: ["review"], pageSize: 50 }).items.length);
	assert.ok(JSON.stringify(clamped).length <= 3_000);
});

test("bounded rescue promotion moves ranker top-3 outsiders into the head and caps at three", () => {
	const names = ["bucket-a", "bucket-b", "bucket-c", "out-1", "out-2", "out-3", "out-4"];
	const sources = names.map((name, index) => ({ name, description: `Source statement ${index}.` }));
	const source: CatalogMetadata = { version: 1, cards: Object.fromEntries(names.map((name, index) => [name, {
		summary: `Distinguishing note ${index}.`,
		tags: [index < 3 ? "testing" : "review"],
		sourceHash: catalogSourceHash(name, `Source statement ${index}.`),
	}])) };
	const page = browseSkillCatalog(sources, source, {
		tags: ["testing"],
		query: "unusual specialist procedure",
		// Overall rank: out-1 0, out-2 1, out-3 2, bucket-a 3, bucket-b 4, bucket-c 5, out-4 6.
		orderedNames: ["out-1", "out-2", "out-3", "bucket-a", "bucket-b", "bucket-c", "out-4"],
	});
	assert.deepEqual(page.items.map(({ name }) => name), ["out-1", "out-2", "out-3", "bucket-a", "bucket-b", "bucket-c", "out-4"]);
	assert.deepEqual(page.items.map(({ rescue }) => rescue ?? false), [true, true, true, false, false, false, false]);
	assert.equal(page.items.filter(({ rescue }) => rescue).length, 3, "promotion is capped at three");
	// Facets and total still describe the complete bucket plus the rescue set.
	assert.deepEqual(page.facets!.map(({ id }) => id), ["testing"]);
	assert.equal(page.total, 7);
	// A tag-consistent query (no outsider in the order) keeps the exact previous order.
	const consistent = browseSkillCatalog(sources, source, { tags: ["testing"], query: "note", orderedNames: ["bucket-c", "bucket-a"] });
	assert.deepEqual(consistent.items.map(({ name }) => name), ["bucket-c", "bucket-a", "bucket-b"]);
	assert.ok(consistent.items.every(({ rescue }) => rescue === undefined));
	// An outsider at overall rank 3 stays behind the complete bucket, unmarked.
	const late = browseSkillCatalog(sources, source, { tags: ["testing"], query: "note", orderedNames: ["bucket-a", "bucket-b", "bucket-c", "out-4"] });
	assert.deepEqual(late.items.map(({ name }) => name), ["bucket-a", "bucket-b", "bucket-c", "out-4"]);
	assert.ok(late.items.every(({ rescue }) => rescue === undefined));
	assert.equal(late.total, 4);
});

test("first page names the remaining candidates so a typical bucket completes in one response", () => {
	const count = 60;
	const { list, source } = diet(count);
	const page = browseSkillCatalog(list, source, { tags: ["review"] });
	assert.ok(page.items.length >= 3);
	assert.ok(page.nextCursor);
	assert.deepEqual([...page.items.map(({ name }) => name), ...page.rest!], list.map(({ name }) => name), "items plus rest enumerate the bucket exactly once");
	assert.ok(page.usedChars <= 3_000);
	assert.equal(page.usedChars, JSON.stringify(page).length);
	const continuation = browseSkillCatalog(list, source, { tags: ["review"], cursor: page.nextCursor });
	assert.equal(continuation.rest, undefined, "rest is first-page-only");
	// Fewer than three complete cards never ships a names-only remainder.
	assert.equal(browseSkillCatalog(list, source, { tags: ["review"], pageSize: 2 }).rest, undefined);
	// A remainder that cannot fit is dropped; the page itself is unchanged.
	const long = Array.from({ length: count }, (_, index) => ({ name: `${"l".repeat(70)}-${String(index).padStart(3, "0")}`, description: "Short note." }));
	const wide = browseSkillCatalog(long);
	assert.equal(wide.rest, undefined);
	assert.ok(wide.nextCursor);
	assert.ok(wide.items.length >= 1);
	assert.ok(wide.usedChars <= 3_000);
	// A bucket that already fits entirely needs no remainder and no cursor.
	const small = diet(10);
	const whole = browseSkillCatalog(small.list, small.source, { tags: ["review"] });
	assert.equal(whole.rest, undefined);
	assert.equal(whole.nextCursor, undefined);
	assert.equal(whole.items.length, 10);
});
