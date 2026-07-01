#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const sourceDir = resolve(cliRoot, "native", "mitm-sidecar");
const outdir = resolve(
	cliRoot,
	process.env.CLAWDI_MITM_SIDECAR_BUNDLE_OUTDIR || "dist-bin/clawdi-mitm-sidecar",
);
const binDir = join(outdir, "bin");
const outfile = join(binDir, "clawdi-mitm-sidecar");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });

const buildEnv = {
	...process.env,
	CGO_ENABLED: process.env.CLAWDI_MITM_SIDECAR_CGO_ENABLED || "0",
};
if (process.env.CLAWDI_MITM_SIDECAR_GOOS) {
	buildEnv.GOOS = process.env.CLAWDI_MITM_SIDECAR_GOOS;
}
if (process.env.CLAWDI_MITM_SIDECAR_GOARCH) {
	buildEnv.GOARCH = process.env.CLAWDI_MITM_SIDECAR_GOARCH;
}

run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outfile, "."], {
	cwd: sourceDir,
	env: buildEnv,
});
chmodSync(outfile, 0o755);

const goVersion = spawnSync("go", ["version"], { encoding: "utf8", stdio: "pipe" });
writeFileSync(
	join(outdir, "manifest.json"),
	`${JSON.stringify(
		{
			schemaVersion: "clawdi.mitmSidecarBundle.v1",
			kind: "native-go",
			entrypoint: "bin/clawdi-mitm-sidecar",
			source: "native/mitm-sidecar",
			go: goVersion.status === 0 ? goVersion.stdout.trim() : null,
			cgoEnabled: buildEnv.CGO_ENABLED,
			goos: buildEnv.GOOS ?? null,
			goarch: buildEnv.GOARCH ?? null,
		},
		null,
		2,
	)}\n`,
);

console.log(`built native MITM sidecar bundle ${outdir}`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	if (result.stdout.trim()) process.stdout.write(result.stdout);
	if (result.stderr.trim()) process.stderr.write(result.stderr);
}
