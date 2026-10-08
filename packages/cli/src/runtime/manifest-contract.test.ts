import { describe, expect, test } from "bun:test";
import {
	HOSTED_HERMES_DASHBOARD_ARGS,
	isHostedHermesDashboardArgs,
	officialInstallArgs,
} from "./manifest-contract";

test("accepts only the dashboard arguments emitted by Hosted", () => {
	const args = ["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"] as const;
	expect(HOSTED_HERMES_DASHBOARD_ARGS).toEqual(args);
	expect(isHostedHermesDashboardArgs(args)).toBe(true);
	expect(isHostedHermesDashboardArgs([...args, "--skip-build"])).toBe(false);
});

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
