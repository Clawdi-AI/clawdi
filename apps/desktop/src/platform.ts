export type DesktopPlatform = "darwin" | "linux" | "win32";

export function requireDesktopPlatform(platform: string = process.platform): DesktopPlatform {
	if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
	throw new Error(`Unsupported Desktop platform: ${platform}`);
}

export function requireDesktopArchitecture(arch: string = process.arch): "arm64" | "x64" {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported Desktop architecture: ${arch}`);
}
