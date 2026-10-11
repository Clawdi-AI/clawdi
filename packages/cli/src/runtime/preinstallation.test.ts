import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cliUpdate from "./cli-update";
import * as codexProvider from "./managed-codex-provider";
import * as manifestInstall from "./manifest-install";
import * as mitmproxyFetch from "./mitmproxy-fetch";
import { getRuntimePaths } from "./paths";
import {
	anonymousInstallerEnvironment,
	preinstallationSpecSchema,
	preinstallationTreeSha256,
	prepareRuntimePreinstallation,
} from "./preinstallation";

const roots: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
	mock.restore();
	process.env = { ...savedEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spec = {
	schemaVersion: "clawdi.runtime-preinstallation.v1" as const,
	imageFingerprint: "a".repeat(64),
	architecture: process.arch === "arm64" ? ("arm64" as const) : ("x64" as const),
	cliPackageSpec: "clawdi@1.2.3",
	runtime: "openclaw" as const,
};
const fileBrowserAsset = {
	url: "https://github.com/gtsteffaniak/filebrowser/releases/download/v1.5.0-stable/linux-amd64-filebrowser",
	sha256: "b".repeat(64),
};
const egressEngine = {
	type: "mitmproxy" as const,
	version: "12.2.3",
	url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
	sha256: "c".repeat(64),
};

function prepareFixture() {
	const root = mkdtempSync(join(tmpdir(), "clawdi-preinstallation-fill-"));
	roots.push(root);
	const home = join(root, "home");
	const state = join(root, "state");
	mkdirSync(home);
	mkdirSync(state);
	Object.assign(process.env, {
		CLAWDI_RUNTIME_HOME: home,
		CLAWDI_SERVICE_STATE_DIR: state,
		CLAWDI_RUN_DIR: join(root, "run"),
	});
	const paths = getRuntimePaths({ mode: "hosted" });
	spyOn(manifestInstall, "observeRuntimeInstall").mockImplementation(() => {
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		mkdirSync(join(home, ".hermes/hermes-agent/.git"), { recursive: true });
		writeFileSync(join(home, ".hermes/hermes-agent/.git/HEAD"), `${"d".repeat(40)}\n`);
		const commandPath = join(home, ".local/bin/hermes");
		writeFileSync(
			commandPath,
			`#!/bin/sh\nif [ "$1" = --version ]; then echo Hermes; else echo '${home}/.hermes/config.yaml'; fi\n`,
			{ mode: 0o755 },
		);
		return {
			runtime: "hermes",
			enabled: true,
			status: "installed",
			commandPath,
			executionUser: null,
			appRoot: null,
			install: null,
			installerUrl: null,
			executedInstallerUrl: null,
			exitCode: 0,
			error: null,
		};
	});
	spyOn(codexProvider, "ensureHostedCodexCli").mockReturnValue({});
	spyOn(cliUpdate, "applyRuntimeCliDesiredState").mockImplementation(() => ({
		status: "current",
		packageSpec: spec.cliPackageSpec,
		registry: null,
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: null,
		version: "1.2.3",
		retryAt: null,
		selfReexec: false,
	}));
	const bytes = "verified Files release fixture\n";
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "asset"), bytes);
	writeFileSync(
		join(root, "bin/curl"),
		`#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp '${root}/asset' "$2"\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
	const prepare = (fields: object = {}) =>
		prepareRuntimePreinstallation(
			{ ...spec, runtime: "hermes", ...fields },
			{ home, state, uid: process.getuid?.(), gid: process.getgid?.(), hosted: { paths } },
		);
	return {
		prepare,
		paths,
		asset: { ...fileBrowserAsset, sha256: createHash("sha256").update(bytes).digest("hex") },
	};
}

describe("anonymous runtime preinstallation", () => {
	test("accepts the selector, image and runtime identity without optional assets", () => {
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

	test("accepts tenant-independent pins and rejects unknown nested fields and bad hashes", () => {
		const pinned = { ...spec, egressEngine, fileBrowserAsset };
		expect(preinstallationSpecSchema.parse(pinned)).toEqual(pinned);
		for (const invalid of [
			{ ...pinned, tenantId: "tenant" },
			{ ...pinned, egressEngine: { ...egressEngine, token: "tenant" } },
			{ ...pinned, fileBrowserAsset: { ...fileBrowserAsset, token: "tenant" } },
			{ ...pinned, egressEngine: { ...egressEngine, sha256: "bad" } },
			{ ...pinned, fileBrowserAsset: { ...fileBrowserAsset, sha256: "bad" } },
		])
			expect(preinstallationSpecSchema.safeParse(invalid).success).toBe(false);
	});

	test.each([
		"https://evil.test/filebrowser",
		fileBrowserAsset.url.replace("github.com", "github.com.evil.test"),
		fileBrowserAsset.url.replace("github.com", "user@github.com"),
		fileBrowserAsset.url.replace("https:", "http:"),
		fileBrowserAsset.url.replace("v1.5.0-stable", "../v1.5.0-stable"),
		`${fileBrowserAsset.url}?token=tenant`,
		`${fileBrowserAsset.url}#fragment`,
		`${fileBrowserAsset.url}/extra`,
	])("rejects a non-official Files URL: %s", (url) => {
		expect(
			preinstallationSpecSchema.safeParse({
				...spec,
				fileBrowserAsset: { ...fileBrowserAsset, url },
			}).success,
		).toBe(false);
	});

	test("Files checksum mismatch fails preparation without sealing a receipt", () => {
		const f = prepareFixture();
		expect(() => f.prepare({ fileBrowserAsset })).toThrow("Files companion SHA256 mismatch");
		expect(existsSync(join(f.paths.serviceStateRoot, "preinstallation/receipt.json"))).toBe(false);
		expect(readdirSync(join(f.paths.fileBrowserInstallRoot, "candidates"))).toEqual([]);
	});

	test("an unavailable pinned egress engine fails preparation", () => {
		const f = prepareFixture();
		spyOn(mitmproxyFetch, "ensureRuntimeMitmproxy").mockReturnValue({
			status: "degraded",
			...egressEngine,
			error: "mitmproxy checksum mismatch",
		});
		expect(() => f.prepare({ egressEngine })).toThrow("egress engine preparation failed");
		expect(existsSync(join(f.paths.serviceStateRoot, "preinstallation/receipt.json"))).toBe(false);
	});

	test("seals both optional pins and the Files candidate in the ordinary claim cache", () => {
		const f = prepareFixture();
		const engine = spyOn(mitmproxyFetch, "ensureRuntimeMitmproxy").mockReturnValue({
			status: "ready",
			...egressEngine,
			cacheDir: "cache",
			binaryPath: "mitmdump",
		});
		expect(f.prepare({ egressEngine, fileBrowserAsset: f.asset })).toMatchObject({
			egressEngine,
			fileBrowserAsset: f.asset,
		});
		expect(engine).toHaveBeenCalledWith(egressEngine, f.paths);
		expect(
			existsSync(join(f.paths.fileBrowserInstallRoot, "candidates", f.asset.sha256, "filebrowser")),
		).toBe(true);
	});

	test("preparation without pins retains the ordinary installation path", () => {
		const f = prepareFixture();
		const engine = spyOn(mitmproxyFetch, "ensureRuntimeMitmproxy");
		const receipt = f.prepare();
		expect(receipt.egressEngine).toBeUndefined();
		expect(receipt.fileBrowserAsset).toBeUndefined();
		expect(engine).not.toHaveBeenCalled();
		expect(existsSync(f.paths.fileBrowserInstallRoot)).toBe(false);
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
		roots.push(root);
		mkdirSync(join(root, "nested"));
		writeFileSync(join(root, "nested", "runtime.txt"), "openclaw\n");
		const before = preinstallationTreeSha256(root);
		writeFileSync(join(root, "nested", "runtime.txt"), "hermes\n");
		expect(preinstallationTreeSha256(root)).not.toBe(before);
	});
});
