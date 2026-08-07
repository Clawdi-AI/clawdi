import { isValidSemver } from "./semver";

export const NATIVE_RELEASE_MANIFEST_SCHEMA = "clawdi.nativeRelease.v1";
export const NATIVE_RELEASE_MANIFEST_NAME = "clawdi-cli-manifest.txt";
export const MAX_NATIVE_MANIFEST_BYTES = 64 * 1024;
export const NATIVE_RELEASE_REPOSITORY = "Clawdi-AI/clawdi";

export const NATIVE_TARGET_CATALOG = [
	{ target: "linux-x64", bunTarget: "bun-linux-x64-baseline" },
	{ target: "linux-arm64", bunTarget: "bun-linux-arm64" },
	{ target: "linux-x64-musl", bunTarget: "bun-linux-x64-musl" },
	{ target: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl" },
	{ target: "darwin-x64", bunTarget: "bun-darwin-x64" },
	{ target: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
] as const;

export type NativeTarget = (typeof NATIVE_TARGET_CATALOG)[number]["target"];
export const NATIVE_TARGETS = NATIVE_TARGET_CATALOG.map((entry) => entry.target);

export interface NativeReleaseArtifact {
	target: NativeTarget;
	asset: string;
	sha256: string;
}

export interface NativeReleaseManifest {
	schemaVersion: typeof NATIVE_RELEASE_MANIFEST_SCHEMA;
	version: string;
	artifacts: NativeReleaseArtifact[];
}

export function isNativeTarget(value: string): value is NativeTarget {
	return (NATIVE_TARGETS as readonly string[]).includes(value);
}

export function nativeAssetName(target: NativeTarget): string {
	return `clawdi-cli-${target}.tar.gz`;
}

export function nativeTargetForPlatform(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	libc: "glibc" | "musl" = "glibc",
): NativeTarget | null {
	const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
	const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
	return os && cpu
		? (`${os}-${cpu}${os === "linux" && libc === "musl" ? "-musl" : ""}` as NativeTarget)
		: null;
}

export function parseNativeReleaseManifest(content: string): NativeReleaseManifest {
	const lines = content.split("\n").filter((line) => line.length > 0);
	if (lines[0] !== NATIVE_RELEASE_MANIFEST_SCHEMA) {
		throw new Error("unsupported native release manifest schema");
	}
	const versionFields = lines[1]?.split("\t") ?? [];
	if (
		versionFields.length !== 2 ||
		versionFields[0] !== "version" ||
		!isValidSemver(versionFields[1] ?? "")
	) {
		throw new Error("native release manifest has an invalid version");
	}
	const version = versionFields[1];
	if (!version) throw new Error("native release manifest has an invalid version");
	const artifacts = lines.slice(2).map((line): NativeReleaseArtifact => {
		const fields = line.split("\t");
		const [recordType, target, asset, sha256] = fields;
		if (
			fields.length !== 4 ||
			recordType !== "artifact" ||
			!target ||
			!isNativeTarget(target) ||
			asset === undefined ||
			sha256 === undefined ||
			!/^[0-9a-f]{64}$/.test(sha256)
		) {
			throw new Error("native release manifest has an invalid artifact entry");
		}
		if (asset !== nativeAssetName(target)) {
			throw new Error("native release manifest target and asset do not match");
		}
		return { target, asset, sha256 };
	});
	if (artifacts.length !== NATIVE_TARGETS.length) {
		throw new Error("native release manifest does not contain the supported target matrix");
	}
	if (new Set(artifacts.map((artifact) => artifact.target)).size !== artifacts.length) {
		throw new Error("native release manifest contains duplicate targets");
	}
	for (const target of NATIVE_TARGETS) {
		if (!artifacts.some((artifact) => artifact.target === target)) {
			throw new Error(`native release manifest is missing ${target}`);
		}
	}
	return { schemaVersion: NATIVE_RELEASE_MANIFEST_SCHEMA, version, artifacts };
}

export function nativeReleaseBaseUrl(
	version: string,
	repository = NATIVE_RELEASE_REPOSITORY,
): string {
	if (!isValidSemver(version)) throw new Error(`invalid native release version: ${version}`);
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error("invalid native release repository");
	}
	return `https://github.com/${repository}/releases/download/clawdi-cli-v${version}`;
}
