import { normalizeDesktopUpdateFeedUrl } from "./update-policy";

export interface DesktopReleaseConfiguration {
	version: string;
	teamId: string;
	updateFeedUrl: string;
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
	const teamId = env.CLAWDI_DESKTOP_TEAM_ID?.trim() ?? "";
	if (!/^[A-Z0-9]{10}$/.test(teamId)) {
		throw new Error("CLAWDI_DESKTOP_TEAM_ID must be the 10-character Developer ID Team ID.");
	}
	const updateFeedUrl = normalizeDesktopUpdateFeedUrl(env.CLAWDI_DESKTOP_UPDATE_FEED_URL);
	if (!updateFeedUrl) {
		throw new Error(
			"CLAWDI_DESKTOP_UPDATE_FEED_URL must be an explicit strict HTTPS generic feed URL.",
		);
	}

	const notarizationMode = readNotarizationMode(env);
	if (!notarizationMode) {
		throw new Error(
			"Apple notarization requires APPLE_API_KEY/API_KEY_ID/API_ISSUER, APPLE_ID/APP_SPECIFIC_PASSWORD/TEAM_ID, or APPLE_KEYCHAIN_PROFILE.",
		);
	}
	return { version, teamId, updateFeedUrl, notarizationMode };
}

export function desktopReleaseBuilderArgs(configuration: DesktopReleaseConfiguration): string[] {
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
		`--config.extraMetadata.version=${configuration.version}`,
		"--config.extraMetadata.clawdiUpdateChannel=stable",
		`--config.extraMetadata.clawdiUpdateFeedUrl=${configuration.updateFeedUrl}`,
		`--config.extraMetadata.clawdiUpdateTeamId=${configuration.teamId}`,
		"--config.publish.provider=generic",
		`--config.publish.url=${configuration.updateFeedUrl}`,
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
