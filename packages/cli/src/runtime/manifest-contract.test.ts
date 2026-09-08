import { describe, expect, test } from "bun:test";
import { officialInstallArgs } from "./manifest-contract";

describe("official runtime installer arguments", () => {
	test("keeps Hermes on the official installer's latest release", () => {
		expect(officialInstallArgs("hermes", "/home/clawdi")).toEqual([
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
