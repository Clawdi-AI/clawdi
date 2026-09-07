import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const forbiddenProtocols = /^(catalog|workspace):/;
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const addonSource = "egress-addon/clawdi_egress_addon.py";
const checkPack = process.argv[2] === "--pack-json";
if (process.argv.length > 3 || (process.argv[2] && !checkPack)) {
	console.error("Usage: check-publish-manifest.mjs [--pack-json < npm-pack.json]");
	process.exit(2);
}

const problems = [];
let tarball;
if (Object.hasOwn(packageJson.publishConfig ?? {}, "tag")) {
	problems.push("published CLI package must not declare publishConfig.tag");
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
const addonEntries = packageFiles.filter(
	(entry) =>
		typeof entry === "string" && (entry === "egress-addon" || entry.startsWith("egress-addon/")),
);
if (addonEntries.length !== 1 || addonEntries[0] !== addonSource) {
	problems.push(`package.json files must include only the exact addon source "${addonSource}"`);
}
if (!packageFiles.includes("skills")) {
	problems.push('package.json files must include "skills"');
}

if (checkPack) {
	try {
		const inventory = JSON.parse(readFileSync(0, "utf8"));
		const packed = Array.isArray(inventory) && inventory.length === 1 ? inventory[0] : null;
		if (
			!packed ||
			packed.name !== packageJson.name ||
			packed.version !== packageJson.version ||
			packed.filename !== `${packageJson.name}-${packageJson.version}.tgz` ||
			!Array.isArray(packed.files) ||
			packed.files.some((file) => !file || typeof file.path !== "string" || !file.path)
		) {
			problems.push("npm pack inventory must describe one exact CLI package with file paths");
		} else {
			const paths = packed.files.map((file) => file.path);
			if (!paths.includes(addonSource))
				problems.push(`npm pack inventory is missing ${addonSource}`);
			for (const path of paths) {
				if (
					path.split("/").includes("__pycache__") ||
					path.endsWith(".pyc") ||
					path.endsWith(".pyo")
				) {
					problems.push(`npm pack inventory contains Python cache or bytecode: ${path}`);
				}
			}
			tarball = packed.filename;
		}
	} catch {
		problems.push("could not read valid npm pack JSON inventory from stdin");
	}
}

if (problems.length > 0) {
	console.error("The CLI package is not ready to publish:");
	for (const problem of problems) {
		console.error(`- ${problem}`);
	}
	process.exit(1);
}
if (checkPack) console.log(tarball);
