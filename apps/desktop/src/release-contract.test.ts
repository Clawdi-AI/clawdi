import { describe, expect, test } from "bun:test";
import { desktopReleaseBuilderArgs, readDesktopReleaseConfiguration } from "./release-contract";

const RELEASE_ENV = {
	CLAWDI_DESKTOP_ARCH: "arm64",
	CLAWDI_DESKTOP_VERSION: "1.2.3",
	CLAWDI_DESKTOP_UPDATE_FEED_URL: "https://downloads.example.test/clawdi/desktop/stable/",
	CSC_NAME: "Developer ID Application: Clawdi, Inc.",
	APPLE_API_KEY: "/private/AuthKey.p8",
	APPLE_API_KEY_ID: "KEY123",
	APPLE_API_ISSUER: "issuer-id",
} as const;

describe("Desktop release contract", () => {
	test("builds the selected Intel target and rejects unsupported architectures", () => {
		const intel = readDesktopReleaseConfiguration(
			{ ...RELEASE_ENV, CLAWDI_DESKTOP_ARCH: "x64" },
			"darwin",
		);
		expect(desktopReleaseBuilderArgs(intel)).toContain("--x64");
		expect(() =>
			readDesktopReleaseConfiguration({ ...RELEASE_ENV, CLAWDI_DESKTOP_ARCH: "ia32" }, "darwin"),
		).toThrow();
	});
	test("accepts an imported CI signing keychain", () => {
		expect(
			readDesktopReleaseConfiguration(
				{ ...RELEASE_ENV, CSC_NAME: "", CSC_KEYCHAIN: "/tmp/signing.keychain" },
				"darwin",
			).channel,
		).toBe("stable");
	});
	test("isolates beta metadata and rejects mismatched versions", () => {
		const beta = {
			...RELEASE_ENV,
			CLAWDI_DESKTOP_UPDATE_CHANNEL: "beta",
			CLAWDI_DESKTOP_VERSION: "1.2.3-beta.1",
		};
		const args = desktopReleaseBuilderArgs(readDesktopReleaseConfiguration(beta, "darwin"));
		expect(args).toContain("--config.publish.channel=beta");
		expect(args).toContain("--config.generateUpdatesFilesForAllChannels=false");
		for (const env of [
			{ ...beta, CLAWDI_DESKTOP_VERSION: "1.2.3" },
			{ ...beta, CLAWDI_DESKTOP_UPDATE_CHANNEL: "stable" },
			{ ...beta, CLAWDI_DESKTOP_VERSION: "1.2.3-beta.01" },
			{ ...beta, CLAWDI_DESKTOP_UPDATE_CHANNEL: "alpha" },
		])
			expect(() => readDesktopReleaseConfiguration(env, "darwin")).toThrow();
	});
	test("fails closed without a signed stable generic feed configuration", () => {
		for (const env of [
			{},
			{ ...RELEASE_ENV, APPLE_API_KEY: "" },
			{ ...RELEASE_ENV, APPLE_API_KEY_ID: "" },
			{ ...RELEASE_ENV, APPLE_API_ISSUER: "" },
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

	test("accepts API key notarization without a separate Team ID", () => {
		expect(readDesktopReleaseConfiguration(RELEASE_ENV, "darwin")).toEqual({
			version: "1.2.3",
			arch: "arm64",
			channel: "stable",
			updateFeedUrl: "https://downloads.example.test/clawdi/desktop/stable/",
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
		expect(args).toContain("--config.dmg.sign=true");
		expect(args).toContain("--config.extraMetadata.clawdiUpdateChannel=stable");
		expect(args).toContain(
			"--config.extraMetadata.clawdiUpdateFeedUrl=https://downloads.example.test/clawdi/desktop/stable/",
		);
		expect(args).toContain("--config.publish.provider=generic");
	});
});
