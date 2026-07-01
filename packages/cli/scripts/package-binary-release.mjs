#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const distBin = resolve(cliRoot, "dist-bin");
const outdir = resolve(cliRoot, "dist-release");
const assetName = process.env.CLAWDI_BINARY_RELEASE_ASSET || "clawdi-cli-linux-x64.tar.gz";
const assetPath = resolve(outdir, assetName);
const checksumPath = `${assetPath}.sha256`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

run("test", ["-x", resolve(distBin, "clawdi")]);
run("test", ["-x", resolve(distBin, "clawdi-mitm-sidecar", "bin", "clawdi-mitm-sidecar")]);
run("tar", [
	"-C",
	distBin,
	"--owner=0",
	"--group=0",
	"--numeric-owner",
	"-czf",
	assetPath,
	"clawdi",
	"clawdi-mitm-sidecar",
]);

const checksum = run("sha256sum", [assetPath]).trim().split(/\s+/)[0];
writeFileSync(checksumPath, `${checksum}  ${basename(assetPath)}\n`);

console.log(`packaged ${assetPath}`);
console.log(`sha256 ${checksum}`);

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	if (result.stderr.trim()) process.stderr.write(result.stderr);
	return result.stdout;
}
