import type { DesktopPlatform } from "./platform";

export type DesktopUpdateChannel = "stable" | "beta";
export type DesktopArchitecture = "arm64" | "x64";

export function standardUpdateMetadataName(
	platform: DesktopPlatform,
	arch: DesktopArchitecture,
	channel: DesktopUpdateChannel,
): string {
	const base = channel === "stable" ? "latest" : "beta";
	if (platform === "darwin") return `${base}-mac.yml`;
	if (platform === "linux") return `${base}-linux${arch === "arm64" ? "-arm64" : ""}.yml`;
	return `${base}.yml`;
}

// Shared by site generation and comparison, including feeds omitted by a pause.
export const desktopUpdateSiteTargets = (["stable", "beta"] as const).flatMap((channel) =>
	(["darwin", "linux", "win32"] as const).flatMap((platform) =>
		(["arm64", "x64"] as const).map((arch) => {
			const filename = standardUpdateMetadataName(platform, arch, channel);
			const directory =
				platform === "darwin" && arch === "arm64" ? "desktop" : `desktop/${platform}-${arch}`;
			return { channel, platform, arch, path: `${directory}/${filename}` };
		}),
	),
);

export function releaseAssetMetadataName(
	platform: DesktopPlatform,
	arch: DesktopArchitecture,
	channel: DesktopUpdateChannel,
): string {
	const standard = standardUpdateMetadataName(platform, arch, channel);
	if (platform === "darwin") {
		return arch === "arm64" ? standard : standard.replace(/\.yml$/, "-x64.yml");
	}
	const base = channel === "stable" ? "latest" : "beta";
	return `${base}-${platform}-${arch}.yml`;
}
