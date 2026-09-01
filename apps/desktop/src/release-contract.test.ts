import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopReleaseBuilderArgs, readDesktopReleaseConfiguration } from "./release-contract";

const packageJson = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as Record<string, unknown>;

describe("Desktop release contract", () => {
	test("keeps preview metadata disabled and configures GitHub update artifacts", () => {
		const build = packageJson.build as {
			extraMetadata?: Record<string, unknown>;
			publish?: Array<Record<string, unknown>>;
			mac?: { hardenedRuntime?: boolean; target?: Array<{ target?: string }> };
		};
		const dependencies = packageJson.dependencies as Record<string, unknown>;
		expect(dependencies["electron-updater"]).toBe("6.8.9");
		expect(build.extraMetadata?.clawdiUpdateChannel).toBe("disabled");
		expect(build.publish).toEqual([
			{
				provider: "github",
				owner: "Clawdi-AI",
				repo: "clawdi",
				releaseType: "release",
			},
		]);
		expect(build.mac?.hardenedRuntime).toBe(true);
		expect(build.mac?.target?.map((target) => target.target)).toEqual(["dmg", "zip"]);
	});

	test("requires stable version, signing, and an official notarization credential tuple", () => {
		expect(() => readDesktopReleaseConfiguration({}, "darwin")).toThrow();
		expect(
			readDesktopReleaseConfiguration(
				{
					CLAWDI_DESKTOP_VERSION: "1.2.3",
					CSC_NAME: "Developer ID Application: Clawdi, Inc.",
					APPLE_API_KEY: "/private/AuthKey.p8",
					APPLE_API_KEY_ID: "KEY123",
					APPLE_API_ISSUER: "issuer-id",
				},
				"darwin",
			),
		).toEqual({ version: "1.2.3", notarizationMode: "api-key" });
	});

	test("builds both updater artifacts without publishing", () => {
		const args = desktopReleaseBuilderArgs("1.2.3");
		expect(args).toContain("dmg");
		expect(args).toContain("zip");
		expect(args).toContain("never");
		expect(args).toContain("--config.forceCodeSigning=true");
		expect(args).toContain("--config.mac.notarize=true");
		expect(args).toContain("--config.extraMetadata.clawdiUpdateChannel=stable");
	});
});
