import { describe, expect, test } from "bun:test";
import {
	HERMES_INSTALL_COMMIT,
	OFFICIAL_INSTALL_URLS,
	officialInstallArgs,
} from "./manifest-contract";

describe("official runtime installer arguments", () => {
	test("pins Hermes to the verified upstream release", () => {
		expect(OFFICIAL_INSTALL_URLS.hermes).toBe(
			`https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_COMMIT}/scripts/install.sh`,
		);
		expect(officialInstallArgs("hermes", "/home/clawdi")).toEqual([
			"--commit",
			HERMES_INSTALL_COMMIT,
			"--force-commit",
			"--skip-setup",
			"--skip-browser",
			"--non-interactive",
		]);
	});

	test("keeps OpenClaw on the official installer's latest release", () => {
		expect(officialInstallArgs("openclaw", "/srv/tenant")).toEqual([
			"--json",
			"--no-onboard",
			"--prefix",
			"/srv/tenant/.local",
		]);
	});
});
