import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.platform;
const arch = process.arch;
if (!["darwin", "linux", "win32"].includes(platform) || (arch !== "arm64" && arch !== "x64")) {
	throw new Error(`Desktop runtime is not supported on ${platform}-${arch}.`);
}
for (const args of [
	["run", "build"],
	["run", "prepare:native"],
	[
		"run",
		"electron-builder",
		`--config.afterPack=${resolve(root, "scripts/after-pack.mjs")}`,
		...(platform === "darwin"
			? ["--mac", "dmg", "zip"]
			: platform === "win32"
				? ["--win", "nsis"]
				: ["--linux", "AppImage", "deb", "rpm"]),
		`--${arch}`,
		"--publish",
		"never",
	],
]) {
	const child = Bun.spawn(["bun", ...args], {
		cwd: root,
		env: { ...process.env, CLAWDI_NATIVE_TARGET: `${platform}-${arch}` },
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) throw new Error(`Desktop packaging failed: ${args.join(" ")}`);
}
