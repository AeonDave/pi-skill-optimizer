import { readFileSync } from "node:fs";
import { ACTIVATION_TASKS } from "./activation.ts";

/** Bump only when an explicit init must regenerate previously current hints. */
export const INIT_PROFILE_VERSION = 5;

export const INIT_PROFILE_PROMPT = readFileSync(
	new URL("./prompts/init-profile.md", import.meta.url),
	"utf8",
).replace("{{ACTIVATION_TASKS}}", JSON.stringify(ACTIVATION_TASKS));
