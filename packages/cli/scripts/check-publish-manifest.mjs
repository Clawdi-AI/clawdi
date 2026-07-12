import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const forbiddenProtocols = /^(catalog|workspace):/;
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

const problems = [];
const publishTag = packageJson.publishConfig?.tag;
if (
	typeof packageJson.version === "string" &&
	!packageJson.version.includes("-") &&
	typeof publishTag === "string" &&
	publishTag.length > 0
) {
	problems.push("stable package versions must not declare publishConfig.tag");
}
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
	problems.push("published bundled CLI package must not declare runtime dependencies");
}
for (const field of dependencyFields) {
	const dependencies = packageJson[field];
	if (!dependencies || typeof dependencies !== "object") continue;
	for (const [name, specifier] of Object.entries(dependencies)) {
		if (typeof specifier === "string" && forbiddenProtocols.test(specifier)) {
			problems.push(`${field}.${name} uses ${specifier}`);
		}
	}
}

const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
if (!packageFiles.includes("egress-addon")) {
	problems.push('package.json files must include "egress-addon"');
}

if (problems.length > 0) {
	console.error("The published CLI package manifest is not ready:");
	for (const problem of problems) {
		console.error(`- ${problem}`);
	}
	process.exit(1);
}
