import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as tar from "tar";
import { validateNativeArchive } from "../src/lib/native-activation.ts";
import {
	NATIVE_BUILD_TARGET_CATALOG,
	NATIVE_RELEASE_MANIFEST_V2_NAME,
	NATIVE_RELEASE_MANIFEST_V2_SCHEMA,
	nativeAssetName,
	parseNativeReleaseManifestV2,
} from "../src/lib/native-release-manifest.ts";

export function writeNativeReleaseManifest(releaseDir, version) {
	const rows = NATIVE_BUILD_TARGET_CATALOG.map(({ target }) => {
		const asset = nativeAssetName(target);
		const sha256 = createHash("sha256")
			.update(readFileSync(resolve(releaseDir, asset)))
			.digest("hex");
		return `artifact\t${target}\t${asset}\t${sha256}`;
	});
	const v2 = [NATIVE_RELEASE_MANIFEST_V2_SCHEMA, `version\t${version}`, ...rows, ""].join("\n");
	parseNativeReleaseManifestV2(v2);
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
