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
