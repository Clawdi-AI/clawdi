import { describe, expect, test } from "bun:test";
import {
	assertDesktopFeedDoesNotRegress,
	desktopPausedVersions,
	selectDesktopUpdateRelease,
} from "./update-rollout";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = 60 * 60_000;
function release(version: string, age: number) {
	return {
		tag_name: `desktop-v${version}`,
		draft: false,
		prerelease: version.includes("-beta."),
		published_at: new Date(NOW - age * HOUR).toISOString(),
	};
}
function select(
	releases: Record<string, unknown>[],
	paused = "",
	channel: "stable" | "beta" = "stable",
) {
	return selectDesktopUpdateRelease(releases, channel, NOW, desktopPausedVersions(paused));
}

describe("Desktop release rollout", () => {
	test("holds stable for 24h using GitHub published_at, keeps previous eligible release", () => {
		expect(select([release("1.0.0", 80), release("1.1.0", 23.999)])?.version).toBe("1.0.0");
		expect(select([release("1.1.0", 23.999)])).toBeUndefined();
		expect(select([release("1.1.0", -1)])).toBeUndefined();
	});
	test("25% from 24h inclusive to 48h exclusive, then 100%", () => {
		for (const age of [24, 30, 47.999])
			expect(select([release("1.1.0", age)])?.stagingPercentage).toBe(25);
		for (const age of [48, 96])
			expect(select([release("1.1.0", age)])?.stagingPercentage).toBe(100);
	});
	test("skips paused releases, resumes them when removed, can pause an entire channel", () => {
		const releases = [release("1.1.0", 80), release("1.2.0", 50)];
		expect(select(releases, " 1.2.0, 1.2.0, ")?.version).toBe("1.1.0");
		expect(select(releases)?.version).toBe("1.2.0");
		expect(select(releases, "1.1.0,1.2.0")).toBeUndefined();
		expect(() => desktopPausedVersions("not-a-version")).toThrow("comma-separated");
	});
	test("beta is immediate and unstaged but obeys pauses; channels remain independent", () => {
		const releases = [
			release("1.1.0-beta.2", 0),
			release("1.1.0-beta.10", 0),
			release("9.0.0", 100),
		];
		expect(select(releases, "", "beta")?.version).toBe("1.1.0-beta.10");
		expect(select(releases, "", "beta")?.stagingPercentage).toBeUndefined();
		expect(select(releases, "1.1.0-beta.10", "beta")?.version).toBe("1.1.0-beta.2");
		expect(select(releases)?.version).toBe("9.0.0");
	});
	test("semantic ordering, drafts and reruns cannot downgrade the feed", () => {
		const releases = [
			release("1.9.0", 60),
			release("1.10.0", 60),
			{ ...release("9.0.0", 60), draft: true },
		];
		expect(select(releases)?.version).toBe("1.10.0");
		expect(() => assertDesktopFeedDoesNotRegress("1.10.0", "1.9.0", new Set())).toThrow(
			"Refusing to regress",
		);
		expect(() => assertDesktopFeedDoesNotRegress("1.10.0", undefined, new Set())).toThrow(
			"Refusing to regress",
		);
		expect(() => assertDesktopFeedDoesNotRegress("1.10.0", "1.10.0", new Set())).not.toThrow();
		expect(() =>
			assertDesktopFeedDoesNotRegress("1.10.0", "1.9.0", new Set(["1.10.0"])),
		).not.toThrow();
	});
	test("fails closed on missing published_at, instead of relying on tag creation time", () => {
		expect(() => select([{ ...release("1.0.0", 80), published_at: null }])).toThrow("published_at");
	});
});
