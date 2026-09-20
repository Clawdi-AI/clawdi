import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { beginHermesConfigTransaction, commitHermesConfigTransaction } from "./hermes-config";
import type { RuntimeManifest } from "./manifest-contract";
import { applyHostedRuntimeConfigProjection } from "./manifest-runtime-config";

const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-oidc-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("projects only the native self-hosted OIDC provider", () => {
	const home = join(root, "home");
	mkdirSync(join(home, ".hermes"), { recursive: true });
	writeFileSync(
		join(home, ".hermes", "config.yaml"),
		[
			"dashboard:",
			"  basic_auth:",
			"    username: admin",
			"    session_ttl_seconds: 43200",
			"  oauth:",
			"    self_hosted:",
			"      issuer: https://old.example.test",
			"plugins:",
			"  disabled:",
			"    - dashboard_auth/self_hosted",
			"    - custom-plugin",
		].join("\n"),
	);
	const command = join(root, "hermes");
	const mock = fileURLToPath(new URL("../test-support/hermes-config-cli-mock.ts", import.meta.url));
	writeFileSync(
		command,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`,
	);
	chmodSync(command, 0o755);
	const context = beginHermesConfigTransaction({
		command,
		home,
		cwd: home,
		environment: { HERMES_HOME: join(home, ".hermes") },
	});
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_K8fJ3pQm",
		environmentId: "environment-42",
		instanceId: "instance-42",
		generation: 7,
		issuedAt: "2026-09-19T00:00:00.000Z",
		workspaceRoot: home,
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: { hermes: { enabled: true, services: {} } },
		recovery: {},
		hermesDashboardAuth: {
			mode: "oidc",
			provider: "self-hosted",
			deploymentId: "hdep_K8fJ3pQm",
			issuer: "https://api.example.test/v2/hermes/oidc",
			clientId: "clawdi-hermes-hdep_K8fJ3pQm-r7",
			accessRevision: 7,
			publicUrl: "https://hermes.example.test",
			trustedProxies: ["10.173.0.1"],
			activation: { enabled: true, capability: "hermes-self-hosted-oidc-v1" },
		},
	};

	applyHostedRuntimeConfigProjection("hermes", manifest, home, null, home, context);
	expect(commitHermesConfigTransaction(context)).toBe("committed");

	const config = parseYaml(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")) as {
		dashboard: Record<string, unknown>;
		plugins: { disabled: string[] };
	};
	expect(config.dashboard).toEqual({
		oauth: {
			self_hosted: {
				issuer: "https://api.example.test/v2/hermes/oidc",
				client_id: "clawdi-hermes-hdep_K8fJ3pQm-r7",
				scopes: "openid profile email",
			},
		},
		public_url: "https://hermes.example.test",
		trusted_proxies: ["10.173.0.1"],
	});
	expect(config.plugins.disabled).toEqual([
		"custom-plugin",
		"dashboard_auth/basic",
		"dashboard_auth/nous",
	]);
});
