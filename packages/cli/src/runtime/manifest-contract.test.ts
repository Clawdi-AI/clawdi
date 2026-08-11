import { describe, expect, test } from "bun:test";
import { officialInstallArgs } from "./manifest-contract";

describe("official runtime installer arguments", () => {
	test("keeps new Hermes installs on the upstream bundled-Skill defaults", () => {
		expect(officialInstallArgs("hermes", "/home/clawdi")).toEqual([
			"--skip-setup",
			"--skip-browser",
			"--non-interactive",
		]);
		expect(officialInstallArgs("hermes", "/home/clawdi")).not.toContain("--no-skills");
	});

	test("places the official OpenClaw launcher in the runtime user's local bin", () => {
		expect(officialInstallArgs("openclaw", "/srv/tenant")).toEqual([
			"--json",
			"--no-onboard",
			"--prefix",
			"/srv/tenant/.local",
		]);
	});
});
