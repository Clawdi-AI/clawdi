import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const forbiddenProtocols = /^(catalog|workspace):/;
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const cliRoot = fileURLToPath(new URL("..", import.meta.url));

const problems = [];
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
if (!packageFiles.includes("clawdi-mitm-broker")) {
	problems.push('package.json files must include "clawdi-mitm-broker"');
}

try {
	accessSync(join(cliRoot, "clawdi-mitm-broker", "bin", "clawdi-mitm-broker"), constants.X_OK);
} catch {
	problems.push(
		"clawdi-mitm-broker/bin/clawdi-mitm-broker is missing or not executable; run `CLAWDI_MITM_BROKER_BUNDLE_OUTDIR=clawdi-mitm-broker bun run build:mitm-broker` before publishing",
	);
}

if (problems.length > 0) {
	console.error("The published CLI package manifest is not ready:");
	for (const problem of problems) {
		console.error(`- ${problem}`);
	}
	process.exit(1);
}
