import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const repository = process.env.GITHUB_REPOSITORY;
const output = process.argv[2];
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
let channels = 0;
for (const channel of ["stable", "beta"] as const) {
	const pattern =
		channel === "stable"
			? /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
			: /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*))$/;
	const candidates = releases
		.flatMap((release) => {
			const match = typeof release.tag_name === "string" ? pattern.exec(release.tag_name) : null;
			return !release.draft && release.prerelease === (channel === "beta") && match?.[1]
				? [{ release, version: match[1] }]
				: [];
		})
		.sort((a, b) => Bun.semver.order(b.version, a.version));
	const selected = candidates[0];
	if (!selected) continue;
	const { release, version } = selected;
	if (!Array.isArray(release.assets)) throw new Error("Missing release assets.");
	const assets = release.assets;
	const filename = channel === "stable" ? "latest-mac.yml" : "beta-mac.yml";
	const asset = assets.find((item: unknown) => record(item) && item.name === filename);
	if (!record(asset) || typeof asset.id !== "number") throw new Error(`Missing ${filename}.`);
	const metadata: unknown = parse(
		gh([
			"api",
			`repos/${repository}/releases/assets/${asset.id}`,
			"-H",
			"Accept: application/octet-stream",
		]),
	);
	if (!record(metadata) || metadata.version !== version || !Array.isArray(metadata.files)) {
		throw new Error(`Invalid ${filename}.`);
	}
	const assetUrl = (name: unknown): string => {
		if (typeof name !== "string" || !/^[\w.+-]+\.(zip|dmg)$/.test(name))
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
	writeFileSync(join(desktop, filename), stringify(metadata));
	channels++;
}
if (!channels) throw new Error("No published Desktop update channels found.");
