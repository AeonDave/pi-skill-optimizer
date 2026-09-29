import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("release metadata stays aligned", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { name: string; version: string };
	const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")) as {
		name: string;
		version: string;
		packages: Record<string, { name?: string; version?: string }>;
	};
	const readme = readFileSync(new URL("README.md", root), "utf8");
	const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");

	assert.equal(pkg.name, "@aeondave/pi-skill-optimizer");
	assert.equal(lock.name, pkg.name);
	assert.equal(lock.packages[""]?.name, pkg.name);
	assert.equal(lock.version, pkg.version, "package-lock top-level version must match package.json");
	assert.equal(lock.packages[""]?.version, pkg.version, "package-lock root package version must match package.json");
	assert.ok(readme.includes(`pi install npm:${pkg.name}@${pkg.version}`));
	assert.ok(readme.includes(`pi install npm:${pkg.name}`));
	assert.ok(readme.includes(`pi update npm:${pkg.name}`));
	assert.ok(readme.includes("pi remove npm:pi-skill-optimizer"), "migration must avoid loading both package identities");
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
	// Host peers are wildcard by Pi's packaging contract; the tested floor lives in devDependencies/docs.
	const piFloor = pkg.devDependencies["@earendil-works/pi-coding-agent"].replace(/^\^/, "");
	assert.ok(readme.includes(`Pi ${piFloor}+`));
	assert.ok(readme.includes(`Node.js ${nodeFloor.replace(/\.0$/, "")}+`));
	assert.ok(ci.includes(`"${nodeFloor}"`), "CI must validate the exact minimum Node version");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
		assert.equal(pkg.peerDependencies[name], "*");
		assert.equal(pkg.devDependencies[name], `^${piFloor}`);
	}
	assert.equal(pkg.devDependencies["@types/node"].match(/\d+/)?.[0], nodeFloor.split(".")[0]);
});

test("public Pi gallery metadata uses the shipped banner and host-provided dependencies", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
		private: boolean;
		publishConfig?: { access: string };
		keywords: string[];
		files: string[];
		dependencies?: Record<string, string>;
		peerDependencies: Record<string, string>;
		peerDependenciesMeta?: Record<string, { optional: boolean }>;
		devDependencies: Record<string, string>;
		pi: { extensions: string[]; image?: string };
	};
	assert.equal(pkg.private, false);
	assert.equal(pkg.publishConfig?.access, "public");
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
	assert.ok(pkg.pi.image, "gallery image must be a public URL, not just a README image");
	const image = new URL(pkg.pi.image);
	assert.equal(image.protocol, "https:");
	assert.equal(image.hostname, "raw.githubusercontent.com");
	assert.match(image.pathname, /^\/AeonDave\/pi-skill-optimizer\/(?:v\d+\.\d+\.\d+|[a-f0-9]{40})\/assets\/banner\.png$/);
	assert.ok(existsSync(new URL("assets/banner.png", root)));
	assert.ok(existsSync(new URL("src/prompts/init-profile.md", root)), "init needs its runtime prompt in the package");
	assert.deepEqual(pkg.files, [
		"src", "docs/ARCHITECTURE.md", "docs/CONFIGURATION.md", "docs/RANKING.md",
		"assets/banner.png", "README.md", "BENCHMARK.md", "LICENSE", "CHANGELOG.md",
	]);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"]) {
		assert.equal(pkg.dependencies?.[name], undefined, `${name} must come from the Pi host`);
		assert.equal(pkg.peerDependencies[name], "*");
		assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, "standalone npm must not auto-install another host");
		assert.ok(pkg.devDependencies[name], `${name} is still needed for development`);
	}
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
