import { describe, expect, test } from "bun:test";
import {
	NATIVE_BUILD_TARGET_CATALOG,
	NATIVE_RELEASE_MANIFEST_SCHEMA,
	NATIVE_RELEASE_MANIFEST_V2_SCHEMA,
	NATIVE_TARGETS,
	nativeAssetName,
	parseNativeReleaseManifest,
	parseNativeReleaseManifestV2,
} from "./native-release-manifest";

const rows = NATIVE_BUILD_TARGET_CATALOG.map(
	({ target }, index) =>
		`artifact\t${target}\t${nativeAssetName(target)}\t${String(index).repeat(64)}`,
);
const manifest = (schema: string, artifacts: string[]) =>
	[schema, "version\t1.2.3", ...artifacts, ""].join("\n");

describe("native release manifest compatibility", () => {
	test("retains the six-target v1 contract and rejects v2", () => {
		const v1 = manifest(NATIVE_RELEASE_MANIFEST_SCHEMA, rows.slice(0, 6));
		expect(parseNativeReleaseManifest(v1).artifacts.map(({ target }) => target)).toEqual(
			NATIVE_TARGETS,
		);
		expect(() =>
			parseNativeReleaseManifest(manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, rows)),
		).toThrow("unsupported native release manifest schema");
		expect(() =>
			parseNativeReleaseManifest(manifest(NATIVE_RELEASE_MANIFEST_SCHEMA, rows)),
		).toThrow("invalid artifact entry");
	});

	test("round-trips all eight v2 targets with sha256 checksums", () => {
		const content = manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, rows);
		const parsed = parseNativeReleaseManifestV2(content);
		expect(parsed.schemaVersion).toBe(NATIVE_RELEASE_MANIFEST_V2_SCHEMA);
		expect(parsed.version).toBe("1.2.3");
		expect(parsed.artifacts.map(({ target }) => target)).toEqual(
			NATIVE_BUILD_TARGET_CATALOG.map(({ target }) => target),
		);
		for (const { sha256 } of parsed.artifacts) expect(sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(
			manifest(
				parsed.schemaVersion,
				parsed.artifacts.map(
					({ target, asset, sha256 }) => `artifact\t${target}\t${asset}\t${sha256}`,
				),
			),
		).toBe(content);
	});

	test("accepts partial v2 matrices and rejects duplicate known targets", () => {
		expect(
			parseNativeReleaseManifestV2(manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, rows.slice(0, 7)))
				.artifacts,
		).toHaveLength(7);
		const first = rows[0];
		if (!first) throw new Error("fixture row is missing");
		expect(() =>
			parseNativeReleaseManifestV2(
				manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, [...rows.slice(0, 7), first]),
			),
		).toThrow("duplicate targets");
	});

	test("ignores future targets and metadata even when their row format is unknown", () => {
		const content = manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, [
			"metadata\tfuture format",
			"artifact\tfreebsd-x64\tfuture",
			...rows,
			"extra line",
			"artifact\twin32-ia32\tunknown-asset\tunknown-checksum",
		]);
		expect(parseNativeReleaseManifestV2(content).artifacts).toHaveLength(8);
	});

	test("enforces v2 schema, semver, asset names and sha256", () => {
		const valid = manifest(NATIVE_RELEASE_MANIFEST_V2_SCHEMA, rows);
		for (const invalid of [
			manifest(NATIVE_RELEASE_MANIFEST_SCHEMA, rows),
			valid.replace("version\t1.2.3", "version\tinvalid"),
			valid.replace("clawdi-cli-win32-x64.tar.gz", "clawdi-cli-win32-x64.zip"),
			valid.replace("0".repeat(64), "0".repeat(63)),
			valid.replace("0".repeat(64), "A".repeat(64)),
		]) {
			expect(() => parseNativeReleaseManifestV2(invalid)).toThrow();
		}
	});
});
