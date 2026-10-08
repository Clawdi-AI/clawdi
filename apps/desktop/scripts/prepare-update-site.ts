import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { desktopUpdateSiteTargets, releaseAssetMetadataName } from "../src/update-metadata";
import { normalizeDesktopUpdateFeedUrl } from "../src/update-policy";
import {
	assertDesktopFeedDoesNotRegress,
	desktopPausedVersions,
	selectDesktopUpdateRelease,
} from "../src/update-rollout";

const repository = process.env.GITHUB_REPOSITORY;
const output = process.argv[2];
const paused = desktopPausedVersions(process.env.DESKTOP_PAUSED_VERSIONS);
const now = Date.now();
const siteUrl = process.env.DESKTOP_UPDATE_SITE_URL;
if (siteUrl && !normalizeDesktopUpdateFeedUrl(siteUrl))
	throw new Error("Invalid existing update site URL.");
if (!repository || !/^[\w-]+\/[\w.-]+$/.test(repository) || !output) {
	throw new Error("GITHUB_REPOSITORY and an output directory are required.");
}

function gh(args: string[]): string {
	return execFileSync("gh", args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 60_000,
	});
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const pages: unknown = JSON.parse(
	gh(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
);
if (!Array.isArray(pages) || !pages.every(Array.isArray))
	throw new Error("Invalid release response.");
const releases = pages.flat().filter(record);
const desktop = join(output, "desktop");
mkdirSync(desktop, { recursive: true });
// An empty site deliberately removes feeds when every release is paused.
writeFileSync(
	join(output, "index.html"),
	"<!doctype html><title>Clawdi Desktop updates</title>Clawdi Desktop update metadata.",
);
for (const { channel, arch, platform, path: relative } of desktopUpdateSiteTargets) {
	const destination = join(output, relative);
	rmSync(destination, { force: true });
	const selected = selectDesktopUpdateRelease(releases, channel, now, paused);
	if (siteUrl) {
		const response = await fetch(new URL(relative, siteUrl), {
			signal: AbortSignal.timeout(15_000),
			cache: "no-store",
		});
		if (response.ok) {
			const previous: unknown = parse(await response.text());
			if (!record(previous) || typeof previous.version !== "string")
				throw new Error(`Invalid existing ${relative}.`);
			assertDesktopFeedDoesNotRegress(previous.version, selected?.version, paused);
		} else if (response.status !== 404) {
			throw new Error(`Could not read existing ${relative}: HTTP ${response.status}.`);
		}
	}
	if (!selected) continue;
	const { release, version } = selected;
	if (!Array.isArray(release.assets)) throw new Error("Missing release assets.");
	const assets = release.assets;
	const assetName = releaseAssetMetadataName(platform, arch, channel);
	const asset = assets.find((item: unknown) => record(item) && item.name === assetName);
	const platformMetadataPattern = new RegExp(`-${platform}-(x64|arm64)\\.yml$`);
	const hasPlatformMatrix =
		platform !== "darwin" &&
		assets.some(
			(item: unknown) =>
				record(item) && typeof item.name === "string" && platformMetadataPattern.test(item.name),
		);
	if (!asset && hasPlatformMatrix)
		throw new Error(`Incomplete Desktop release: missing ${assetName}.`);
	// Releases predating Intel support contain only the arm64 metadata.
	if (!asset && (arch === "x64" || platform !== "darwin")) continue;
	if (!record(asset) || typeof asset.id !== "number") throw new Error(`Missing ${relative}.`);
	const metadata: unknown = parse(
		gh([
			"api",
			`repos/${repository}/releases/assets/${asset.id}`,
			"-H",
			"Accept: application/octet-stream",
		]),
	);
	if (
		!record(metadata) ||
		metadata.version !== version ||
		!Array.isArray(metadata.files) ||
		metadata.files.length === 0
	) {
		throw new Error(`Invalid ${relative}.`);
	}
	const assetUrl = (name: unknown): string => {
		const artifactPattern =
			platform === "linux"
				? /^[\w.+-]+\.AppImage$/
				: platform === "win32"
					? /^[\w.+-]+\.exe$/
					: /^[\w.+-]+\.(zip|dmg)$/;
		if (typeof name !== "string" || !artifactPattern.test(name))
			throw new Error("Invalid artifact filename.");
		const artifact = assets.find((item: unknown) => record(item) && item.name === name);
		if (!record(artifact)) throw new Error(`Missing artifact ${name}.`);
		return `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
	};
	for (const file of metadata.files) {
		if (!record(file) || typeof file.sha512 !== "string") throw new Error("Invalid update file.");
		file.url = assetUrl(file.url);
	}
	if (metadata.path !== undefined) metadata.path = assetUrl(metadata.path);
	delete metadata.stagingPercentage;
	if (selected.stagingPercentage !== undefined)
		metadata.stagingPercentage = selected.stagingPercentage;
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, stringify(metadata));
}
