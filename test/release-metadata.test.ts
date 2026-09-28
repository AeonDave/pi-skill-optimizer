import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("release metadata stays aligned", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string };
	const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
		version: string;
		packages: Record<string, { version?: string }>;
	};
	const readme = readFileSync(new URL("README.md", root), "utf8");
	const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");

	assert.equal(lock.version, pkg.version, "package-lock top-level version must match package.json");
	assert.equal(lock.packages[""]?.version, pkg.version, "package-lock root package version must match package.json");
	assert.match(readme, new RegExp(`pi-skill-optimizer@${pkg.version.replaceAll(".", "\\.")}`));
	assert.match(changelog, new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}`, "m"));
});

test("runtime floors match development dependencies, installation docs and CI", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
		engines: { node: string };
		peerDependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	const readme = readFileSync(new URL("README.md", root), "utf8");
	const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
	const nodeFloor = pkg.engines.node.replace(/^>=/, "");
	const piFloor = pkg.peerDependencies["@earendil-works/pi-coding-agent"].replace(/^>=/, "");
	assert.ok(readme.includes(`Pi ${piFloor}+`));
	assert.ok(readme.includes(`Node.js ${nodeFloor.replace(/\.0$/, "")}+`));
	assert.ok(ci.includes(`"${nodeFloor}"`), "CI must validate the exact minimum Node version");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
		assert.equal(pkg.peerDependencies[name], `>=${piFloor}`);
		assert.equal(pkg.devDependencies[name], `^${piFloor}`);
	}
	assert.equal(pkg.devDependencies["@types/node"].match(/\d+/)?.[0], nodeFloor.split(".")[0]);
});

test("README and reference links resolve to files shipped in the package", () => {
	const rootPath = fileURLToPath(root);
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { files: string[] };
	const documents = ["README.md", "BENCHMARK.md", ...readdirSync(new URL("docs/", root))
		.filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
	for (const document of documents) {
		const file = resolve(rootPath, document);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
			const target = match[1].split("#")[0];
			if (!target || /^[a-z]+:/i.test(target)) continue;
			const path = resolve(dirname(file), decodeURIComponent(target));
			assert.ok(existsSync(path), `${document}: missing linked file ${target}`);
			const packaged = relative(rootPath, path).replaceAll("\\", "/");
			assert.ok(pkg.files.some((entry) => packaged === entry || packaged.startsWith(`${entry}/`)),
				`${document}: ${target} is not included in package.files`);
		}
	}
});
