import { describe, expect, test } from "bun:test";
import { officialInstallArgs } from "./manifest-contract";

describe("official runtime installer arguments", () => {
	test("keeps Hermes on the official installer's latest release", () => {
		expect(officialInstallArgs("hermes", "/home/clawdi")).toEqual([
			"--skip-setup",
			"--skip-browser",
			"--non-interactive",
		]);
		expect(officialInstallArgs("hermes", "/home/clawdi")).not.toContain("--no-skills");
		expect(officialInstallArgs("hermes", "/home/clawdi")).not.toContain("--version");
	});

	test("keeps OpenClaw on the official installer's latest release", () => {
		expect(officialInstallArgs("openclaw", "/srv/tenant")).toEqual([
			"--json",
			"--no-onboard",
			"--prefix",
			"/srv/tenant/.local",
		]);
		expect(officialInstallArgs("openclaw", "/srv/tenant")).not.toContain("--version");
	});
});
