import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HERMES_CODEX_AUTH_HELPER,
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
	test("resolves OpenClaw provider auth through the public package export", () => {
		const packageRoot = tempRoot();
		const sdkPath = join(packageRoot, "provider-auth.mjs");
		const commandPath = join(packageRoot, "bin", "openclaw");
		mkdirSync(join(packageRoot, "bin"), { recursive: true });
		writeFileSync(commandPath, "#!/bin/sh\n");
		writeFileSync(sdkPath, "export const publicProviderAuth = true;\n");
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: { "./plugin-sdk/provider-auth": "./provider-auth.mjs" },
			}),
		);

		expect(resolveOpenClawProviderAuthSdkExport([commandPath])).toBe(sdkPath);
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
});
