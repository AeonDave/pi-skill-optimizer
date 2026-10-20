import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG_TAGS } from "../src/catalog.ts";
import { INIT_PROFILE_PROMPT, INIT_PROFILE_VERSION } from "../src/init-prompt.ts";

test("explicit init version 6 requires semantic catalog cards from the shared tag vocabulary", () => {
	assert.equal(INIT_PROFILE_VERSION, 6);
	assert.match(INIT_PROFILE_PROMPT, /"catalogCards"/);
	assert.match(INIT_PROFILE_PROMPT, /one useful distinguishing sentence/i);
	assert.match(INIT_PROFILE_PROMPT, /200 characters/i);
	assert.match(INIT_PROFILE_PROMPT, /Do not emit.*sourceHash|Never emit.*sourceHash/i);
	assert.doesNotMatch(INIT_PROFILE_PROMPT, /\{\{(?:ACTIVATION_TASKS|CATALOG_TAGS)\}\}/);
	for (const tag of CATALOG_TAGS) {
		assert.ok(INIT_PROFILE_PROMPT.includes(tag.id), `missing catalog tag ${tag.id}`);
	}
	assert.match(INIT_PROFILE_PROMPT, /`discipline` for skills whose main contribution is execution habits/i);
	assert.match(INIT_PROFILE_PROMPT, /use the canonical `other` tag rather than forcing a nearby/i);
});
