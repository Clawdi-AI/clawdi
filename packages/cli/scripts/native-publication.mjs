import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as tar from "tar";
import { validateNativeArchive } from "../src/lib/native-activation.ts";
import {
	isNativeTarget,
	NATIVE_BUILD_TARGET_CATALOG,
	NATIVE_RELEASE_MANIFEST_NAME,
	NATIVE_RELEASE_MANIFEST_SCHEMA,
	NATIVE_RELEASE_MANIFEST_V2_NAME,
	NATIVE_RELEASE_MANIFEST_V2_SCHEMA,
	nativeAssetName,
	parseNativeReleaseManifest,
	parseNativeReleaseManifestV2,
} from "../src/lib/native-release-manifest.ts";

export function writeNativeReleaseManifests(releaseDir, version) {
	const artifacts = NATIVE_BUILD_TARGET_CATALOG.map(({ target }) => {
		const asset = nativeAssetName(target);
		const sha256 = createHash("sha256")
			.update(readFileSync(resolve(releaseDir, asset)))
			.digest("hex");
		return { target, row: `artifact\t${target}\t${asset}\t${sha256}` };
	});
	// TODO (2026-10-07): stop generating frozen v1 after 2027-01-05, once a
	// release with lenient v2 readers is the oldest supported auto-update path
	// for 90 days. Keep v1 bytes unchanged until that migration is complete.
	const v1 = [
		NATIVE_RELEASE_MANIFEST_SCHEMA,
		`version\t${version}`,
		...artifacts.filter(({ target }) => isNativeTarget(target)).map(({ row }) => row),
		"",
	].join("\n");
	const v2 = [
		NATIVE_RELEASE_MANIFEST_V2_SCHEMA,
		`version\t${version}`,
		...artifacts.map(({ row }) => row),
		"",
	].join("\n");
	parseNativeReleaseManifest(v1);
	parseNativeReleaseManifestV2(v2);
	writeFileSync(resolve(releaseDir, NATIVE_RELEASE_MANIFEST_NAME), v1);
	writeFileSync(resolve(releaseDir, NATIVE_RELEASE_MANIFEST_V2_NAME), v2);
}

// Publication policy is stricter than installation of existing releases.
export async function validateNativePublicationArchive(archive, executableName = "clawdi") {
	await validateNativeArchive(archive, executableName);
	let forbiddenPath;
	await new Promise((resolve, reject) => {
		const stream = tar.list({
			gzip: true,
			strict: true,
			onReadEntry(entry) {
				const path = entry.path;
				if (
					path.split("/").includes("__pycache__") ||
					path.endsWith(".pyc") ||
					path.endsWith(".pyo")
				) {
					forbiddenPath ??= path;
				}
				entry.resume();
			},
		});
		stream.on("end", resolve);
		stream.on("error", reject);
		stream.end(archive);
	});
	if (forbiddenPath) {
		throw new Error(
			`native publication archive contains Python cache or bytecode: ${forbiddenPath}`,
		);
	}
}
