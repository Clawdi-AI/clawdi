#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	NATIVE_BUILD_TARGET_CATALOG,
	NATIVE_RELEASE_MANIFEST_V2_NAME,
	nativeExecutableName,
	parseNativeReleaseManifestV2,
} from "../src/lib/native-release-manifest.ts";
import { validateNativePublicationArchive } from "./native-publication.mjs";

const releaseDir = resolve(process.argv[2] || "dist-release");
const expectedVersion = process.argv[3] || JSON.parse(readFileSync("package.json", "utf8")).version;
const manifestV2Content = readFileSync(
	resolve(releaseDir, NATIVE_RELEASE_MANIFEST_V2_NAME),
	"utf8",
);
const manifestV2 = parseNativeReleaseManifestV2(manifestV2Content);
// Clients ignore future rows; publication must contain exactly the current matrix.
if (
	manifestV2Content.split("\n").filter((line) => line.length > 0).length !==
		NATIVE_BUILD_TARGET_CATALOG.length + 2 ||
	manifestV2.artifacts.length !== NATIVE_BUILD_TARGET_CATALOG.length ||
	NATIVE_BUILD_TARGET_CATALOG.some(
		({ target }) => !manifestV2.artifacts.some((artifact) => artifact.target === target),
	)
) {
	throw new Error("native release manifest does not contain the supported target matrix");
}
if (manifestV2.version !== expectedVersion) {
	throw new Error("native release version mismatch");
}
for (const artifact of manifestV2.artifacts) {
	const path = resolve(releaseDir, artifact.asset);
	const archive = readFileSync(path);
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== artifact.sha256) throw new Error(`checksum mismatch for ${artifact.asset}`);
	await validateNativePublicationArchive(archive, nativeExecutableName(artifact.target));
}

console.log(
	`verified native release ${manifestV2.version} (v2: ${manifestV2.artifacts.length} targets)`,
);
