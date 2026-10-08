import type { DesktopUpdateChannel } from "./update-metadata";

const HOUR_MS = 60 * 60_000;
// Age/pauses only select releases. Rollout uses the standard latest*.yml field:
// https://www.electron.build/docs/features/auto-update/#staged-rollouts
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/;

export function desktopPausedVersions(value = ""): ReadonlySet<string> {
	const versions = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (versions.some((version) => !VERSION.test(version))) {
		throw new Error("DESKTOP_PAUSED_VERSIONS must contain comma-separated Desktop versions.");
	}
	return new Set(versions);
}

export function selectDesktopUpdateRelease(
	releases: readonly Record<string, unknown>[],
	channel: DesktopUpdateChannel,
	now: number,
	paused: ReadonlySet<string>,
): { release: Record<string, unknown>; version: string; stagingPercentage?: number } | undefined {
	if (!Number.isFinite(now)) throw new Error("Invalid update feed time.");
	return releases
		.flatMap((release) => {
			const version =
				typeof release.tag_name === "string" && release.tag_name.startsWith("desktop-v")
					? release.tag_name.slice("desktop-v".length)
					: "";
			if (
				!VERSION.test(version) ||
				release.draft !== false ||
				release.prerelease !== (channel === "beta") ||
				version.includes("-beta.") !== (channel === "beta") ||
				paused.has(version)
			)
				return [];
			if (channel === "beta") return [{ release, version }];
			const publishedAt =
				typeof release.published_at === "string" ? Date.parse(release.published_at) : NaN;
			if (!Number.isFinite(publishedAt))
				throw new Error(`Missing published_at for desktop-v${version}.`);
			const age = now - publishedAt;
			return age < 24 * HOUR_MS
				? []
				: [{ release, version, stagingPercentage: age < 48 * HOUR_MS ? 25 : 100 }];
		})
		.sort((a, b) => Bun.semver.order(b.version, a.version))[0];
}

// Pausing may point the feed back at an earlier release for users who have not
// installed it. Installed clients still refuse downgrades (fix forward only).
// https://www.electron.build/docs/features/auto-update/#staged-rollouts
export function assertDesktopFeedDoesNotRegress(
	previous: unknown,
	next: string | undefined,
	paused: ReadonlySet<string>,
): void {
	if (previous === undefined) return;
	if (typeof previous !== "string" || !VERSION.test(previous))
		throw new Error("Invalid existing feed version.");
	if (!paused.has(previous) && (!next || Bun.semver.order(next, previous) < 0)) {
		throw new Error(`Refusing to regress the Desktop feed from ${previous} to ${next ?? "empty"}.`);
	}
}
