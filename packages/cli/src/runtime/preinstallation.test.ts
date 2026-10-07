import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anonymousInstallerEnvironment,
	preinstallationSpecSchema,
	preinstallationTreeSha256,
} from "./preinstallation";

const spec = {
	schemaVersion: "clawdi.runtime-preinstallation.v1" as const,
	imageFingerprint: "a".repeat(64),
	architecture: process.arch === "arm64" ? ("arm64" as const) : ("x64" as const),
	cliPackageSpec: "clawdi@1.2.3",
	runtime: "openclaw" as const,
};

describe("anonymous runtime preinstallation", () => {
	test("accepts only the selector, image and runtime identity", () => {
		expect(preinstallationSpecSchema.parse(spec)).toEqual(spec);
		expect(preinstallationSpecSchema.safeParse({ ...spec, runtime: "unknown" }).success).toBe(
			false,
		);
		expect(
			preinstallationSpecSchema.safeParse({ ...spec, cliPackageSpec: "clawdi@latest" }).success,
		).toBe(false);
		expect(preinstallationSpecSchema.safeParse({ ...spec, runtimeVersion: "latest" }).success).toBe(
			false,
		);
	});

	test("keeps anonymous installer environment free of tenant credentials and pool proxies", () => {
		const env = anonymousInstallerEnvironment("/home/clawdi");
		expect(env.HOME).toBe("/home/clawdi");
		expect(env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org");
		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(env.CLAWDI_AUTH_TOKEN).toBeUndefined();
		expect(env.CLOUD_API_TOKEN).toBeUndefined();
	});

	test("fingerprints the anonymous home tree and detects changes", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-preinstallation-test-"));
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", "runtime.txt"), "openclaw\n");
		const before = preinstallationTreeSha256(root);
		writeFileSync(join(root, "nested", "runtime.txt"), "hermes\n");
		expect(preinstallationTreeSha256(root)).not.toBe(before);
	});
});
