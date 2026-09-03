import { describe, expect, test } from "bun:test";
import { desktopReleaseBuilderArgs, readDesktopReleaseConfiguration } from "./release-contract";

const RELEASE_ENV = {
	CLAWDI_DESKTOP_VERSION: "1.2.3",
	CLAWDI_DESKTOP_TEAM_ID: "ABC1234567",
	CLAWDI_DESKTOP_UPDATE_FEED_URL: "https://downloads.example.test/clawdi/desktop/stable/",
	CSC_NAME: "Developer ID Application: Clawdi, Inc.",
	APPLE_API_KEY: "/private/AuthKey.p8",
	APPLE_API_KEY_ID: "KEY123",
	APPLE_API_ISSUER: "issuer-id",
} as const;

describe("Desktop release contract", () => {
	test("fails closed without a signed stable generic feed configuration", () => {
		for (const env of [
			{},
			{ ...RELEASE_ENV, CLAWDI_DESKTOP_UPDATE_FEED_URL: "" },
			{ ...RELEASE_ENV, CLAWDI_DESKTOP_UPDATE_FEED_URL: "http://downloads.example.test" },
			{
				...RELEASE_ENV,
				CLAWDI_DESKTOP_UPDATE_FEED_URL: "https://downloads.example.test/clawdi/desktop/stable",
			},
			{ ...RELEASE_ENV, CLAWDI_DESKTOP_UPDATE_FEED_URL: "https://user@downloads.example.test" },
		]) {
			expect(() => readDesktopReleaseConfiguration(env, "darwin")).toThrow();
		}
	});

	test("accepts explicit signing, notarization, Team ID, and strict HTTPS feed inputs", () => {
		expect(readDesktopReleaseConfiguration(RELEASE_ENV, "darwin")).toEqual({
			version: "1.2.3",
			teamId: "ABC1234567",
			updateFeedUrl: "https://downloads.example.test/clawdi/desktop/stable/",
			notarizationMode: "api-key",
		});
	});

	test("embeds signed updater metadata and configures generic artifacts without publishing", () => {
		const configuration = readDesktopReleaseConfiguration(RELEASE_ENV, "darwin");
		const args = desktopReleaseBuilderArgs(configuration);
		expect(args).toContain("dmg");
		expect(args).toContain("zip");
		expect(args).toContain("never");
		expect(args).toContain("--config.forceCodeSigning=true");
		expect(args).toContain("--config.mac.notarize=true");
		expect(args).toContain("--config.extraMetadata.clawdiUpdateChannel=stable");
		expect(args).toContain(
			"--config.extraMetadata.clawdiUpdateFeedUrl=https://downloads.example.test/clawdi/desktop/stable/",
		);
		expect(args).toContain("--config.extraMetadata.clawdiUpdateTeamId=ABC1234567");
		expect(args).toContain("--config.publish.provider=generic");
	});
});
