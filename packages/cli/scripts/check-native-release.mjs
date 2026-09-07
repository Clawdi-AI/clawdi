#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	NATIVE_RELEASE_MANIFEST_NAME,
	parseNativeReleaseManifest,
} from "../src/lib/native-release-manifest.ts";
import { validateNativePublicationArchive } from "./native-publication.mjs";

const releaseDir = resolve(process.argv[2] || "dist-release");
const expectedVersion = process.argv[3] || JSON.parse(readFileSync("package.json", "utf8")).version;
const manifest = parseNativeReleaseManifest(
	readFileSync(resolve(releaseDir, NATIVE_RELEASE_MANIFEST_NAME), "utf8"),
);
if (manifest.version !== expectedVersion) throw new Error("native release version mismatch");

for (const artifact of manifest.artifacts) {
	const path = resolve(releaseDir, artifact.asset);
	const archive = readFileSync(path);
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== artifact.sha256) throw new Error(`checksum mismatch for ${artifact.asset}`);
	await validateNativePublicationArchive(archive);
}

console.log(`verified native release ${manifest.version} (${manifest.artifacts.length} targets)`);
