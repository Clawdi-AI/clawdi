import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeTargetForPlatform } from "../../../packages/cli/src/lib/native-release-manifest";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const cliRoot = join(repositoryRoot, "packages", "cli");
const cliPackage = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as {
	version?: unknown;
};
const version = typeof cliPackage.version === "string" ? cliPackage.version : null;
const target =
	process.env.CLAWDI_NATIVE_TARGET || nativeTargetForPlatform(process.platform, process.arch);
if (!version || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
	throw new Error("CLI package has an invalid version");
}
if (!target) throw new Error(`unsupported desktop build host: ${process.platform}-${process.arch}`);

const build = spawnSync(process.execPath, [join(cliRoot, "scripts", "build-native.mjs")], {
	cwd: repositoryRoot,
	env: { ...process.env, CLAWDI_NATIVE_TARGET: target },
	stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error(`native CLI build failed with exit ${build.status}`);

const source = join(cliRoot, "dist-native", target);
const output = join(desktopRoot, "resources", "native");
if (!existsSync(join(source, "clawdi"))) throw new Error("native CLI build did not produce clawdi");
rmSync(output, { recursive: true, force: true });
mkdirSync(dirname(output), { recursive: true });
cpSync(source, output, { recursive: true });
chmodSync(join(output, "clawdi"), 0o755);

console.log(`prepared Clawdi CLI ${version} (${target}) for Electron`);
