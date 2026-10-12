import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDesktopArchitecture, requireDesktopPlatform } from "../src/platform";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = requireDesktopPlatform();
const arch = requireDesktopArchitecture();
for (const args of [
	["run", "build"],
	["run", "prepare:native"],
	[
		"run",
		"electron-builder",
		...(platform === "darwin"
			? ["--mac", "zip"]
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

// Reuse the packaged app so only hdiutil's DMG work can be retried.
if (platform === "darwin") {
	const child = Bun.spawn(["bash", resolve(root, "../../scripts/build-desktop-dmg.sh"), arch], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) throw new Error("Desktop DMG packaging failed");
}
