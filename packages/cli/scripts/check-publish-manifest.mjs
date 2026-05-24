import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const forbiddenProtocols = /^(catalog|workspace):/;
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

const problems = [];
for (const field of dependencyFields) {
	const dependencies = packageJson[field];
	if (!dependencies || typeof dependencies !== "object") continue;
	for (const [name, specifier] of Object.entries(dependencies)) {
		if (typeof specifier === "string" && forbiddenProtocols.test(specifier)) {
			problems.push(`${field}.${name} uses ${specifier}`);
		}
	}
}

if (problems.length > 0) {
	console.error("The published CLI package cannot contain monorepo-only dependency protocols:");
	for (const problem of problems) {
		console.error(`- ${problem}`);
	}
	console.error("Use a real npm semver/range in packages/cli/package.json before publishing.");
	process.exit(1);
}
