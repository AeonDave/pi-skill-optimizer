import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	searchSkillCatalog,
	type Skill,
	type SkillSearchOptions,
	type SkillSearchResult,
} from "./skills.ts";

export interface SkillRegistryInput {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface SkillResource {
	name: string;
	description: string;
	content: string;
}

export interface SkillLocationAction {
	name: string;
	location: string;
}

export interface SkillResourceFile {
	name: string;
	relativePath: string;
	content: string;
}

export interface SkillRegistryOptions {
	maxResourceBytes?: number;
}

export interface SkillRegistry {
	readonly skills: readonly Skill[];
	search(query: string, options?: SkillSearchOptions): SkillSearchResult;
	loadExact(name: string): SkillResource;
	loadResource(name: string, relativePath: string): SkillResourceFile;
	locateExact(name: string): SkillLocationAction;
}

interface RegistryRecord {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

function containedPath(baseDir: string, filePath: string): string {
	const absoluteBase = resolve(baseDir);
	const candidate = resolve(isAbsolute(filePath) ? filePath : resolve(baseDir, filePath));
	const lexicalRelation = relative(absoluteBase, candidate);
	if (!lexicalRelation || lexicalRelation === ".." || lexicalRelation.startsWith(`..${sep}`) || isAbsolute(lexicalRelation)) {
		throw new Error("Skill resource escapes its registered base directory");
	}
	const realBase = realpathSync.native(absoluteBase);
	const realFile = realpathSync.native(candidate);
	const relation = relative(realBase, realFile);
	if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
		throw new Error("Skill resource escapes its registered base directory");
	}
	const stats = statSync(realFile);
	if (!stats.isFile()) throw new Error("Skill resource is not a regular file");
	return realFile;
}

export function createSkillRegistry(
	inputs: readonly SkillRegistryInput[],
	options: SkillRegistryOptions = {},
): SkillRegistry {
	const maxResourceBytes = Math.max(1, Math.trunc(options.maxResourceBytes ?? 1_048_576));
	const records = new Map<string, RegistryRecord>();
	for (const input of inputs) {
		const name = input.name.trim();
		if (!name) throw new TypeError("Skill registry names must be non-empty");
		if (records.has(name)) throw new TypeError(`Duplicate skill registry name: ${name}`);
		records.set(name, {
			name,
			description: input.description,
			filePath: input.filePath,
			baseDir: input.baseDir,
		});
	}
	const skills = Object.freeze([...records.values()].map((record): Skill => Object.freeze({
		name: record.name,
		description: record.description,
		location: "",
	})));
	const getRecord = (name: string): RegistryRecord => {
		const record = records.get(name);
		if (!record) throw new RangeError(`Unknown skill name: ${name}`);
		return record;
	};
	const resolveRecord = (record: RegistryRecord): string => containedPath(record.baseDir, record.filePath);
	const readBounded = (location: string): string => {
		const stats = statSync(location);
		if (stats.size > maxResourceBytes) {
			throw new RangeError(`Skill resource exceeds ${maxResourceBytes} bytes`);
		}
		return readFileSync(location, "utf8");
	};
	return Object.freeze({
		skills,
		search(query: string, searchOptions: SkillSearchOptions = {}): SkillSearchResult {
			return searchSkillCatalog(skills, query, searchOptions);
		},
		loadExact(name: string): SkillResource {
			const record = getRecord(name);
			const location = resolveRecord(record);
			return {
				name: record.name,
				description: record.description,
				content: readBounded(location),
			};
		},
		loadResource(name: string, relativePath: string): SkillResourceFile {
			const record = getRecord(name);
			if (!relativePath || isAbsolute(relativePath)) {
				throw new TypeError("Skill resource path must be relative");
			}
			const skillRoot = dirname(resolveRecord(record));
			const location = containedPath(skillRoot, resolve(skillRoot, relativePath));
			return {
				name: record.name,
				relativePath,
				content: readBounded(location),
			};
		},
		locateExact(name: string): SkillLocationAction {
			const record = getRecord(name);
			return { name: record.name, location: resolveRecord(record) };
		},
	});
}
