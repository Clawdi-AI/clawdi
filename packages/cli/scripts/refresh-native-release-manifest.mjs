#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeNativeReleaseManifest } from "./native-publication.mjs";

const releaseDir = resolve(process.argv[2] || "dist-release");
const version =
	process.argv[3] ||
	JSON.parse(readFileSync(resolve(releaseDir, "../package.json"), "utf8")).version;

writeNativeReleaseManifest(releaseDir, version);
console.log(`wrote native release manifest for ${version}`);
