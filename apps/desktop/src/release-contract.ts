export interface DesktopReleaseConfiguration {
	version: string;
	notarizationMode: "api-key" | "apple-id" | "keychain-profile";
}

export function readDesktopReleaseConfiguration(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): DesktopReleaseConfiguration {
	if (platform !== "darwin") throw new Error("Desktop release packaging must run on macOS.");
	const version = env.CLAWDI_DESKTOP_VERSION?.trim() ?? "";
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error("CLAWDI_DESKTOP_VERSION must be an explicit stable semver such as 1.2.3.");
	}
	const hasSigningIdentity = Boolean(
		env.CSC_NAME?.trim() || (env.CSC_LINK?.trim() && env.CSC_KEY_PASSWORD),
	);
	if (!hasSigningIdentity) {
		throw new Error(
			"A Developer ID signing identity is required through CSC_NAME or CSC_LINK with CSC_KEY_PASSWORD.",
		);
	}

	const notarizationMode = readNotarizationMode(env);
	if (!notarizationMode) {
		throw new Error(
			"Apple notarization requires APPLE_API_KEY/API_KEY_ID/API_ISSUER, APPLE_ID/APP_SPECIFIC_PASSWORD/TEAM_ID, or APPLE_KEYCHAIN_PROFILE.",
		);
	}
	return { version, notarizationMode };
}

export function desktopReleaseBuilderArgs(version: string): string[] {
	return [
		"x",
		"electron-builder",
		"--mac",
		"dmg",
		"zip",
		"--arm64",
		"--publish",
		"never",
		"--config.forceCodeSigning=true",
		"--config.mac.notarize=true",
		`--config.extraMetadata.version=${version}`,
		"--config.extraMetadata.clawdiUpdateChannel=stable",
	];
}

function readNotarizationMode(
	env: Record<string, string | undefined>,
): DesktopReleaseConfiguration["notarizationMode"] | null {
	if (allPresent(env, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"])) {
		return "api-key";
	}
	if (allPresent(env, ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])) {
		return "apple-id";
	}
	if (env.APPLE_KEYCHAIN_PROFILE?.trim()) return "keychain-profile";
	return null;
}

function allPresent(env: Record<string, string | undefined>, names: string[]): boolean {
	return names.every((name) => Boolean(env[name]?.trim()));
}
