import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireDesktopArchitecture, requireDesktopPlatform } from "../src/platform";
import {
	type DesktopUpdateChannel,
	releaseAssetMetadataName,
	standardUpdateMetadataName,
} from "../src/update-metadata";

const [directoryArg, platformArg, archArg, channelArg] = process.argv.slice(2);
if (!directoryArg || (channelArg !== "stable" && channelArg !== "beta")) {
	throw new Error(
		"usage: isolate-update-metadata.ts <release-directory> <platform> <architecture> <channel>",
	);
}
const platform = requireDesktopPlatform(platformArg);
const arch = requireDesktopArchitecture(archArg);
const channel: DesktopUpdateChannel = channelArg;
const directory = resolve(directoryArg);
const source = join(directory, standardUpdateMetadataName(platform, arch, channel));
const target = join(directory, releaseAssetMetadataName(platform, arch, channel));

if (!existsSync(source)) {
	if (platform === "win32") process.exit(0);
	throw new Error(`Missing update metadata: ${source}`);
}
if (source !== target) renameSync(source, target);
