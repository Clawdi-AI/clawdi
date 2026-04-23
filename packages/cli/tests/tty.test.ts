import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isCI, isInteractive } from "../src/lib/tty";

const CI_ENVS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"TRAVIS",
	"BUILDKITE",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of CI_ENVS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of CI_ENVS) {
		if (saved[k] !== undefined) process.env[k] = saved[k];
		else delete process.env[k];
	}
});

describe("isCI", () => {
	it("returns false when no CI env is set", () => {
		expect(isCI()).toBe(false);
	});

	for (const name of CI_ENVS) {
		it(`returns true when ${name} is set`, () => {
			process.env[name] = "1";
			expect(isCI()).toBe(true);
		});
	}
});

describe("isInteractive", () => {
	it("returns false in CI regardless of TTY", () => {
		process.env.CI = "1";
		expect(isInteractive()).toBe(false);
	});
});
