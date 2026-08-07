import { describe, expect, test } from "bun:test";
import { OFFICIAL_INSTALL_ARGS } from "./manifest-contract";

describe("official runtime installer arguments", () => {
	test("keeps new Hermes installs on the upstream bundled-Skill defaults", () => {
		expect(OFFICIAL_INSTALL_ARGS.hermes).toEqual([
			"--skip-setup",
			"--skip-browser",
			"--non-interactive",
		]);
		expect(OFFICIAL_INSTALL_ARGS.hermes).not.toContain("--no-skills");
	});
});
