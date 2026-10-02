import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [outputDir, profile] = process.argv.slice(2);
if (!outputDir || !profile) throw new Error("Output directory and profile are required");
const status = await readFile(path.join(outputDir, "status.tsv"), "utf8");
const checks = Object.fromEntries(
	status
		.trim()
		.split("\n")
		.map((line) => {
			const [name, exitCode] = line.split("\t");
			return [name, Number(exitCode)];
		}),
);
const audit = JSON.parse(await readFile(path.join(outputDir, "audit.json"), "utf8"));
const summary = {
	profile,
	checkedAt: new Date().toISOString(),
	checks,
	peerConflicts: audit.peerConflicts,
	invalidPeerRanges: audit.invalidPeerRanges,
	singleReactIdentity: audit.singleReactIdentity,
	nativeCompile: audit.nativeCompile,
	productApproved: false,
};
await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (
	Object.values(checks).some((exitCode) => exitCode !== 0) ||
	audit.peerConflicts.length > 0 ||
	audit.singleReactIdentity !== true
) {
	process.exitCode = 1;
}
