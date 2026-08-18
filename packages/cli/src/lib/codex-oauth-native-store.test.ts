import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	HERMES_CODEX_AUTH_HELPER,
	hermesCodexAuthInvocation,
	oauthCredentialFingerprint,
	resolveOpenClawConfigMutationSdkExport,
	resolveOpenClawDeviceBootstrapSdkExport,
	resolveOpenClawProviderAuthSdkExport,
} from "./codex-oauth-native-store";

const tempRoots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-oauth-test-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native OAuth store contracts", () => {
	function runHermesHelper(
		authPath: string,
		action: "inspect" | "upsert",
		profileId: string,
		input: unknown = null,
	) {
		return spawnSync(
			"node",
			[
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				action,
				profileId,
				"",
				"revision-test",
				"missing",
			],
			{ encoding: "utf8", input: JSON.stringify(input) },
		);
	}

	test("resolves OpenClaw public SDK exports through the official installer node symlink", () => {
		const home = tempRoot();
		const versionedNodeRoot = join(home, ".local", "tools", "node-v24.15.0");
		const packageRoot = join(versionedNodeRoot, "lib", "node_modules", "openclaw");
		const providerAuthPath = join(packageRoot, "provider-auth.mjs");
		const configMutationPath = join(packageRoot, "config-mutation.mjs");
		const deviceBootstrapPath = join(packageRoot, "device-bootstrap.mjs");
		const commandPath = join(home, ".local", "bin", "openclaw");
		mkdirSync(dirname(commandPath), { recursive: true });
		mkdirSync(packageRoot, { recursive: true });
		symlinkSync(versionedNodeRoot, join(home, ".local", "tools", "node"), "dir");
		writeFileSync(
			commandPath,
			`#!/usr/bin/env bash
set -euo pipefail
exec "${join(home, ".local", "tools", "node", "bin", "node")}" "${join(packageRoot, "dist", "entry.js")}" "$@"
`,
		);
		writeFileSync(providerAuthPath, "export const publicProviderAuth = true;\n");
		writeFileSync(configMutationPath, "export const publicConfigMutation = true;\n");
		writeFileSync(deviceBootstrapPath, "export const publicDeviceBootstrap = true;\n");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: {
					"./plugin-sdk/provider-auth": "./provider-auth.mjs",
					"./plugin-sdk/config-mutation": "./config-mutation.mjs",
					"./plugin-sdk/device-bootstrap": "./device-bootstrap.mjs",
				},
			}),
		);

		expect(lstatSync(commandPath).isFile()).toBe(true);
		expect(lstatSync(commandPath).isSymbolicLink()).toBe(false);
		expect(resolveOpenClawProviderAuthSdkExport(home, [commandPath])).toBe(providerAuthPath);
		expect(resolveOpenClawConfigMutationSdkExport(home, [commandPath])).toBe(configMutationPath);
		expect(resolveOpenClawDeviceBootstrapSdkExport(home, [commandPath])).toBe(deviceBootstrapPath);
	});

	test("preserves a future Hermes store version and unrelated pool entries", () => {
		const root = tempRoot();
		const authPath = join(root, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				version: 2,
				providers: { anthropic: { api_key: "preserve" } },
				credential_pool: {
					anthropic: [{ id: "user-anthropic", access_token: "preserve" }],
					"openai-codex": [
						{
							id: "user-codex",
							auth_type: "oauth",
							source: "manual:device_code",
							access_token: "user-access",
							refresh_token: "user-refresh",
						},
					],
				},
			}),
		);
		const result = spawnSync(
			"node",
			[
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				"upsert",
				"clawdi:reserved",
				"",
				"revision-1",
				"missing",
			],
			{
				encoding: "utf8",
				input: JSON.stringify({
					accessToken: "clawdi-access",
					refreshToken: "clawdi-refresh",
					lastRefresh: "2026-07-31T00:00:00Z",
				}),
			},
		);
		expect(result.status).toBe(0);
		const store = JSON.parse(readFileSync(authPath, "utf8"));
		expect(store.version).toBe(2);
		expect(store.providers.anthropic.api_key).toBe("preserve");
		expect(store.credential_pool.anthropic).toEqual([
			{ id: "user-anthropic", access_token: "preserve" },
		]);
		expect(store.credential_pool["openai-codex"].map((entry: { id: string }) => entry.id)).toEqual([
			"clawdi:reserved",
			"user-codex",
		]);
	});

	test("fails closed without rewriting an unrecognized Hermes pool shape", () => {
		const root = tempRoot();
		const authPath = join(root, "auth.json");
		const original = JSON.stringify({ version: 3, credential_pool: [] });
		writeFileSync(authPath, original);
		const result = spawnSync(
			"node",
			[
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				"upsert",
				"clawdi:reserved",
			],
			{
				encoding: "utf8",
				input: JSON.stringify({ accessToken: "access", refreshToken: "refresh" }),
			},
		);
		expect(result.status).not.toBe(0);
		expect(readFileSync(authPath, "utf8")).toBe(original);
	});

	test.each([
		{
			name: "unknown array item",
			entries: [null, { id: "user-entry", access_token: "preserve" }],
			error: "unknown entry",
		},
		{
			name: "duplicate reserved ID",
			entries: [
				{ id: "clawdi:reserved", access_token: "first", refresh_token: "first-refresh" },
				{ id: "clawdi:reserved", access_token: "second", refresh_token: "second-refresh" },
			],
			error: "duplicate reserved IDs",
		},
	])("preserves original Hermes bytes for $name", ({ entries, error }) => {
		const root = tempRoot();
		const authPath = join(root, "auth.json");
		const original = `${JSON.stringify({
			version: 1,
			credential_pool: { "openai-codex": entries },
		})}\n`;
		writeFileSync(authPath, original);

		const result = runHermesHelper(authPath, "upsert", "clawdi:reserved", {
			accessToken: "replacement-access",
			refreshToken: "replacement-refresh",
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(error);
		expect(readFileSync(authPath, "utf8")).toBe(original);
	});

	test("rejects Windows mutations instead of bypassing the official Hermes lock", () => {
		expect(() =>
			hermesCodexAuthInvocation(
				"upsert",
				["--input-type=module", "--eval", HERMES_CODEX_AUTH_HELPER],
				"C:\\Hermes\\auth.lock",
				"win32",
			),
		).toThrow("official msvcrt protocol");
		expect(hermesCodexAuthInvocation("inspect", ["--eval", "inspect"], "ignored", "win32")).toEqual(
			{ command: "node", args: ["--eval", "inspect"] },
		);
	});

	test.skipIf(process.platform === "win32")(
		"serializes mutations on the official Hermes auth.lock boundary",
		() => {
			const root = tempRoot();
			const authPath = join(root, "auth.json");
			const lockPath = join(root, "auth.lock");
			const readyPath = join(root, "lock-ready");
			const holder = spawn("flock", [lockPath, "sh", "-c", `touch "${readyPath}"; sleep 0.35`]);
			const deadline = Date.now() + 2_000;
			while (!existsSync(readyPath) && Date.now() < deadline) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
			expect(existsSync(readyPath)).toBe(true);

			const nodeArgs = [
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				"upsert",
				"clawdi:reserved",
				"",
				"revision-lock",
				"missing",
			];
			const invocation = hermesCodexAuthInvocation("upsert", nodeArgs, lockPath);
			const startedAt = Date.now();
			const mutation = spawnSync(invocation.command, invocation.args, {
				encoding: "utf8",
				input: JSON.stringify({ accessToken: "access", refreshToken: "refresh" }),
			});
			const elapsedMs = Date.now() - startedAt;

			expect(mutation.status).toBe(0);
			expect(elapsedMs).toBeGreaterThanOrEqual(200);
			expect(JSON.parse(readFileSync(authPath, "utf8"))).toMatchObject({
				credential_pool: {
					"openai-codex": [{ id: "clawdi:reserved", access_token: "access" }],
				},
			});
			holder.kill();
		},
	);

	test("fences Hermes mutations with before and target credential fingerprints", () => {
		const root = tempRoot();
		const authPath = join(root, "auth.json");
		const profileId = "clawdi:reserved";
		writeFileSync(
			authPath,
			`${JSON.stringify({
				version: 1,
				credential_pool: {
					"openai-codex": [
						{
							id: profileId,
							auth_type: "oauth",
							source: "manual:device_code",
							access_token: "before-access",
							refresh_token: "before-refresh",
						},
					],
				},
			})}\n`,
		);
		const original = readFileSync(authPath, "utf8");
		const revision = "revision-2";
		const targetMaterial = {
			accessToken: "target-access",
			refreshToken: "target-refresh",
			lastRefresh: "2026-07-31T00:00:00Z",
		};
		const wrongBefore = `sha256:${"f".repeat(64)}`;
		const rejected = spawnSync(
			"node",
			[
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				"upsert",
				profileId,
				profileId,
				revision,
				wrongBefore,
			],
			{ encoding: "utf8", input: JSON.stringify(targetMaterial) },
		);
		expect(rejected.status).toBe(0);
		expect(JSON.parse(rejected.stdout)).toMatchObject({ updated: false, casMatched: false });
		expect(readFileSync(authPath, "utf8")).toBe(original);

		const beforeFingerprint = oauthCredentialFingerprint(
			revision,
			"before-access",
			"before-refresh",
		);
		const applied = spawnSync(
			"node",
			[
				"--input-type=module",
				"--eval",
				HERMES_CODEX_AUTH_HELPER,
				authPath,
				"upsert",
				profileId,
				profileId,
				revision,
				beforeFingerprint,
			],
			{ encoding: "utf8", input: JSON.stringify(targetMaterial) },
		);
		expect(applied.status).toBe(0);
		expect(JSON.parse(applied.stdout)).toMatchObject({
			updated: true,
			casMatched: true,
			beforeCredentialFingerprint: beforeFingerprint,
			afterCredentialFingerprint: oauthCredentialFingerprint(
				revision,
				targetMaterial.accessToken,
				targetMaterial.refreshToken,
			),
		});
	});
});
