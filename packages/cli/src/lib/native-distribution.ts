import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import {
	isNativeTarget,
	MAX_NATIVE_MANIFEST_BYTES,
	NATIVE_RELEASE_MANIFEST_NAME,
	NATIVE_TARGETS,
	type NativeTarget,
	parseNativeReleaseManifest,
} from "./native-release-manifest";
import { isValidSemver } from "./semver";

declare const CLAWDI_CLI_VERSION: string | undefined;
declare const CLAWDI_NATIVE_TARGET: string | undefined;

export interface NativeInstallOwnership {
	kind: "native";
	prefix: string;
	versionsRoot: string;
	versionDir: string;
	version: string;
	target: NativeTarget;
	executable: string;
	launcher: string;
}

export interface NativeCompiledIdentity {
	version: string;
	target: NativeTarget;
}

export const NATIVE_INSTALL_IDENTITY_NAME = "clawdi-native-install.txt";
const NATIVE_INSTALL_IDENTITY_SCHEMA = "clawdi.nativeInstall.v1";
const MAX_NATIVE_IDENTITY_BYTES = 4096;

/**
 * Recognize the one repository-owned native layout. The stable launcher must
 * be a symlink to the exact immutable executable that is currently running.
 */
export function detectNativeInstall(
	executablePath: string,
	compiledIdentity: NativeCompiledIdentity | null = currentNativeCompiledIdentity(),
): NativeInstallOwnership | null {
	if (!compiledIdentity) return null;
	let executable: string;
	try {
		executable = realpathSync.native(executablePath);
	} catch {
		return null;
	}
	if (basename(executable) !== "clawdi") return null;

	const versionDir = dirname(executable);
	const versionsRoot = dirname(versionDir);
	const clawdiRoot = dirname(versionsRoot);
	const shareDir = dirname(clawdiRoot);
	const prefix = dirname(shareDir);
	if (
		basename(versionsRoot) !== "versions" ||
		basename(clawdiRoot) !== "clawdi" ||
		basename(shareDir) !== "share"
	) {
		return null;
	}

	const identity = parseVersionDirectoryName(basename(versionDir));
	if (
		!identity ||
		identity.version !== compiledIdentity.version ||
		identity.target !== compiledIdentity.target
	) {
		return null;
	}
	try {
		const manifestPath = join(versionDir, NATIVE_RELEASE_MANIFEST_NAME);
		const manifestFile = lstatSync(manifestPath);
		if (!manifestFile.isFile() || manifestFile.size > MAX_NATIVE_MANIFEST_BYTES) return null;
		const manifest = parseNativeReleaseManifest(readFileSync(manifestPath, "utf8"));
		if (
			manifest.version !== identity.version ||
			!manifest.artifacts.some((artifact) => artifact.target === identity.target)
		) {
			return null;
		}
		validateNativeInstallIdentity(versionDir, compiledIdentity, manifest);
		if (!lstatSync(join(versionDir, "egress-addon")).isDirectory()) return null;
		if (!lstatSync(join(versionDir, "skills")).isDirectory()) return null;
		if (!lstatSync(join(versionDir, "egress-addon", "clawdi_egress_addon.py")).isFile())
			return null;
		if (!lstatSync(join(versionDir, "skills", "clawdi", "SKILL.md")).isFile()) return null;
	} catch {
		return null;
	}
	const launcher = join(prefix, "bin", "clawdi");
	try {
		if (!lstatSync(launcher).isSymbolicLink()) return null;
		if (realpathSync.native(launcher) !== executable) return null;
	} catch {
		return null;
	}
	return {
		kind: "native",
		prefix: normalize(resolve(prefix)),
		versionsRoot: normalize(resolve(versionsRoot)),
		versionDir: normalize(resolve(versionDir)),
		version: identity.version,
		target: identity.target,
		executable,
		launcher,
	};
}

export function writeNativeInstallIdentity(
	directory: string,
	identity: NativeCompiledIdentity,
	manifestContent: string,
): void {
	const manifest = parseNativeReleaseManifest(manifestContent);
	const artifact = manifest.artifacts.find((entry) => entry.target === identity.target);
	if (manifest.version !== identity.version || !artifact) {
		throw new Error("native release manifest does not match executable identity");
	}
	writeFileSync(
		join(directory, NATIVE_INSTALL_IDENTITY_NAME),
		[
			NATIVE_INSTALL_IDENTITY_SCHEMA,
			`version\t${identity.version}`,
			`target\t${identity.target}`,
			`asset\t${artifact.asset}`,
			`sha256\t${artifact.sha256}`,
			"",
		].join("\n"),
		{ mode: 0o644 },
	);
}

export function validateNativeInstallIdentity(
	directory: string,
	identity: NativeCompiledIdentity,
	manifestContent: string | ReturnType<typeof parseNativeReleaseManifest>,
): void {
	const manifest =
		typeof manifestContent === "string"
			? parseNativeReleaseManifest(manifestContent)
			: manifestContent;
	const artifact = manifest.artifacts.find((entry) => entry.target === identity.target);
	if (manifest.version !== identity.version || !artifact) {
		throw new Error("native release manifest does not match executable identity");
	}
	const path = join(directory, NATIVE_INSTALL_IDENTITY_NAME);
	const marker = lstatSync(path);
	if (!marker.isFile()) throw new Error("native install identity is not a regular file");
	if (marker.size > MAX_NATIVE_IDENTITY_BYTES) {
		throw new Error("native install identity exceeds the size limit");
	}
	const lines = readFileSync(path, "utf8").split("\n");
	const expected = [
		NATIVE_INSTALL_IDENTITY_SCHEMA,
		`version\t${identity.version}`,
		`target\t${identity.target}`,
		`asset\t${artifact.asset}`,
		`sha256\t${artifact.sha256}`,
		"",
	];
	if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
		throw new Error("native install identity is invalid");
	}
}

export function currentNativeCompiledIdentity(): NativeCompiledIdentity | null {
	if (
		typeof CLAWDI_CLI_VERSION === "undefined" ||
		!isValidSemver(CLAWDI_CLI_VERSION) ||
		typeof CLAWDI_NATIVE_TARGET === "undefined" ||
		!isNativeTarget(CLAWDI_NATIVE_TARGET)
	) {
		return null;
	}
	return { version: CLAWDI_CLI_VERSION, target: CLAWDI_NATIVE_TARGET };
}

export function nativeVersionDirectoryName(version: string, target: NativeTarget): string {
	if (!isValidSemver(version)) throw new Error(`invalid native version: ${version}`);
	return `${version}-${target}`;
}

function parseVersionDirectoryName(name: string): { version: string; target: NativeTarget } | null {
	for (const target of NATIVE_TARGETS) {
		const suffix = `-${target}`;
		if (!name.endsWith(suffix)) continue;
		const version = name.slice(0, -suffix.length);
		return isValidSemver(version) ? { version, target } : null;
	}
	return null;
}
