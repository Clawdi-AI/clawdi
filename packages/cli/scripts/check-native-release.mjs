#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	isNativeTarget,
	NATIVE_RELEASE_MANIFEST_NAME,
	NATIVE_RELEASE_MANIFEST_V2_NAME,
	nativeExecutableName,
	parseNativeReleaseManifest,
	parseNativeReleaseManifestV2,
} from "../src/lib/native-release-manifest.ts";
import { validateNativePublicationArchive } from "./native-publication.mjs";

const releaseDir = resolve(process.argv[2] || "dist-release");
const expectedVersion = process.argv[3] || JSON.parse(readFileSync("package.json", "utf8")).version;
const manifest = parseNativeReleaseManifest(
	readFileSync(resolve(releaseDir, NATIVE_RELEASE_MANIFEST_NAME), "utf8"),
);
const manifestV2 = parseNativeReleaseManifestV2(
	readFileSync(resolve(releaseDir, NATIVE_RELEASE_MANIFEST_V2_NAME), "utf8"),
);
if (manifest.version !== expectedVersion || manifestV2.version !== expectedVersion) {
	throw new Error("native release version mismatch");
}
const unixArtifacts = manifestV2.artifacts.filter(({ target }) => isNativeTarget(target));
if (JSON.stringify(manifest.artifacts) !== JSON.stringify(unixArtifacts)) {
	throw new Error("native release v1 artifacts do not match v2 Unix artifacts");
}

for (const artifact of manifestV2.artifacts) {
	const path = resolve(releaseDir, artifact.asset);
	const archive = readFileSync(path);
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== artifact.sha256) throw new Error(`checksum mismatch for ${artifact.asset}`);
	await validateNativePublicationArchive(archive, nativeExecutableName(artifact.target));
}

console.log(
	`verified native release ${manifest.version} (v1: ${manifest.artifacts.length} targets, v2: ${manifestV2.artifacts.length} targets)`,
);
