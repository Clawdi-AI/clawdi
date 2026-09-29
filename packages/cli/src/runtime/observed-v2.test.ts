import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { runtimeWatchEventForOutcome } from "../commands/runtime";
import { getCliVersion } from "../lib/version";
import {
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
	runtimeContentSha256,
	runtimeProviderConflicts,
	runtimeServiceWithdrawals,
	writeRuntimeAppliedState,
} from "./applied-state";
import type { RuntimeApplyContext } from "./apply-identity";
import { componentConfigurationRevision } from "./component-observation";
import { HostedRuntimeHeartbeatSession } from "./heartbeat-observation";
import { HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, loadRemoteRuntimeManifest } from "./manifest-source";
import {
	readComponentServiceState,
	readHostedRuntimeObserved,
	runtimeComponentIsReady,
} from "./observed";
import { getRuntimePaths } from "./paths";
import { runtimeRunConfigPath } from "./run-config";
import {
	buildRuntimeBootStatus,
	readRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "./state";
import { readSystemdComponentFingerprint } from "./systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";
import { recordRuntimeUserActivityScan } from "./user-activity-state";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function healthyAppliedRuntimePaths(enabledRuntimes: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-watch-error-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "systemd");
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.serviceStateRoot);
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: "2026-08-19T00:00:00.000Z",
			instanceId: "hri_watch_error",
			etag: '"bundle-applied"',
			manifestETag: '"manifest-applied"',
			applyReceiptId: "apply-receipt-watch-error",
			bootNonce: "boot-nonce-watch-error",
			sourceRevision: "d".repeat(64),
			generation: 1,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: "e".repeat(64),
			},
			activated: {},
			providerIds: [],
			projectedProviderIds: {},
		},
		paths,
	);
	writeRuntimeBootStatus(
		buildRuntimeBootStatus(
			{
				mode: "normal",
				status: "ok",
				stage: "final",
				bootId: "boot-watch-error",
				runtimeMode: "hosted",
				activeGeneration: 1,
				instanceId: "hri_watch_error",
				enabledRuntimes,
				errors: [],
				exitCode: 0,
				datasource: "RuntimeSource",
				hostPolicy: {
					source: "file",
					path: paths.hostPolicy,
					exists: true,
					valid: true,
					mode: "hosted",
				},
				timestamp: "2026-08-19T00:00:00.000Z",
			},
			paths,
		),
		paths,
	);
	return paths;
}

describe("hosted runtime observed v2", () => {
	test("reports applied authority and keeps status version separate from the active process", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot, { mode: 0o700 });
		chmodSync(paths.serviceStateRoot, 0o700);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T06:00:00.000Z",
				instanceId: "hri_observed",
				etag: '"bundle-applied"',
				manifestETag: '"frozen-companion-manifest"',
				applyReceiptId: "apply-receipt-observed-v2",
				bootNonce: "boot-nonce-observed-v2-01",
				sourceRevision: "a".repeat(64),
				generation: 2,
				applyGeneration: 1,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: ["managed"],
				projectedProviderIds: { openclaw: ["managed", "fallback"] },
			},
			paths,
		);
		mkdirSync(dirname(paths.cliBootstrapStatus), { recursive: true });
		writeFileSync(
			paths.cliBootstrapStatus,
			JSON.stringify({
				schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
				generatedAt: "2026-07-13T06:00:00.000Z",
				status: "installed",
				source: "npm",
				packageSpec: "clawdi@0.0.0-stale",
				registry: "https://registry.npmjs.org",
				npmPrefix: paths.cliNpmPrefix,
				npmCache: paths.cliNpmCache,
				activePath: paths.cliManagedBin,
				activeTarget: join(paths.cliNpmPrefix, "bin", "clawdi"),
				version: "0.0.0-stale",
				verification: {
					verifiedAt: "2026-07-13T06:00:00.000Z",
					device: 0,
					inode: 0,
					size: 0,
					modifiedAtMs: 0,
				},
				previous: null,
				bad: null,
				error: null,
			}),
		);
		chmodSync(paths.cliBootstrapStatus, 0o600);

		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.schemaVersion).toBe("clawdi.hostedRuntimeObserved.v2");
		expect(observed?.activeCliVersion).toBe(getCliVersion());
		expect(observed?.cli?.version).toBe("0.0.0-stale");
		expect(observed?.applied).toEqual({
			etag: '"bundle-applied"',
			sourceRevision: "a".repeat(64),
			generation: 1,
			instanceId: "hri_observed",
			appliedProviderIds: ["managed"],
		});
		expect(JSON.stringify(observed)).not.toContain("b".repeat(64));
		expect(observed?.applied).not.toHaveProperty("contentIdentity");
	});

	test("reports missing applied state as unknown authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const observed = await readHostedRuntimeObserved(getRuntimePaths({ mode: "hosted" }));
		expect(observed?.applied).toBeNull();
		expect(observed?.status).toBe("unknown");
	});

	test("keeps last-good runtime healthy when a desired projection fails", async () => {
		const paths = healthyAppliedRuntimePaths();
		writeRuntimeWatchStatus(
			{
				status: "error",
				stage: "final",
				error: "runtime hermes sourced Skill projection failed",
				healthImpact: "resource_projection",
			},
			paths,
		);

		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("ok");
		expect(observed?.convergeError).toBe("runtime hermes sourced Skill projection failed");
	});

	test("keeps transport-only fetch failures diagnostic only for the exact healthy committed runtime", async () => {
		const paths = healthyAppliedRuntimePaths();
		const applied = readRuntimeAppliedState(paths);
		const identity = applied ? runtimeAppliedApplyIdentity(applied) : null;
		const boot = readRuntimeBootStatus(paths).status;
		if (!applied || !identity || !boot) throw new Error("Expected committed fixture");
		const context: RuntimeApplyContext = {
			kind: "context-file",
			backend: "incus",
			identity,
			manifestSource: {
				type: "http",
				url: "https://runtime.example.test/manifest",
				auth: { type: "bearer", token: "fixture" },
			},
		};
		globalThis.fetch = Object.assign(
			async () => {
				throw new TypeError("fetch failed");
			},
			{ preconnect: () => undefined },
		);
		const failure = await loadRemoteRuntimeManifest(paths, { applyContext: context });
		if (!("errors" in failure)) throw new Error("Expected transport failure");
		expect(failure).toMatchObject({ failureKind: "transport", requestedApplyIdentity: identity });
		const event = runtimeWatchEventForOutcome({ kind: "load_failed", failure }, paths);
		if (!event) throw new Error("Expected watch error");
		expect(event).toHaveProperty("healthImpact", "manifest_transport");
		writeRuntimeWatchStatus(event, paths);
		const healthy = await readHostedRuntimeObserved(paths);
		expect(healthy?.status).toBe("ok");
		expect(healthy?.convergeError).toBe("could not fetch runtime manifest: fetch failed");
		expect(runtimeWatchEventForOutcome({ kind: "load_failed", failure }, paths)).toHaveProperty(
			"healthImpact",
			"manifest_transport",
		);
		writeRuntimeWatchStatus({ ...event, stage: "final" }, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		const mutationFailure = runtimeWatchEventForOutcome(
			{ kind: "apply_error", error: "fetch failed" },
			paths,
		);
		if (!mutationFailure) throw new Error("Expected mutation failure");
		expect(mutationFailure).not.toHaveProperty("healthImpact");
		writeRuntimeWatchStatus(mutationFailure, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		const afterMutation = runtimeWatchEventForOutcome({ kind: "load_failed", failure }, paths);
		if (!afterMutation) throw new Error("Expected transport failure after mutation");
		expect(afterMutation).not.toHaveProperty("healthImpact");
		writeRuntimeWatchStatus(afterMutation, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");

		for (const change of [
			{ generation: identity.generation + 1 },
			{ manifestETag: '"other"' },
			{ applyReceiptId: "different-receipt" },
			{ bootNonce: "different-boot-nonce" },
		]) {
			const mismatched = await loadRemoteRuntimeManifest(paths, {
				applyContext: { ...context, identity: { ...identity, ...change } },
			});
			if (!("errors" in mismatched)) throw new Error("Expected transport failure");
			const rejected = runtimeWatchEventForOutcome(
				{ kind: "load_failed", failure: mismatched },
				paths,
			);
			if (!rejected) throw new Error("Expected watch error");
			expect(rejected).not.toHaveProperty("healthImpact");
			writeRuntimeWatchStatus(rejected, paths);
			expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		}
		writeRuntimeWatchStatus(event, paths);
		writeRuntimeAppliedState({ ...applied, sourceRevision: "c".repeat(64) }, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		writeRuntimeAppliedState(applied, paths);
		writeRuntimeBootStatus({ ...boot, activeGeneration: applied.generation + 1 }, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		writeRuntimeBootStatus({ ...boot, status: "error" }, paths);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		rmSync(paths.bootStatus);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		writeRuntimeBootStatus(boot, paths);
		rmSync(paths.appliedState);
		expect(runtimeWatchEventForOutcome({ kind: "load_failed", failure }, paths)).not.toHaveProperty(
			"healthImpact",
		);
		expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
	});

	test.each([
		{ status: 401, contentType: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, body: "unauthorized" },
		{ status: 403, contentType: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, body: "forbidden" },
		{ status: 503, contentType: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, body: "unavailable" },
		{ status: 200, contentType: "application/json", body: "{}" },
		{ status: 200, contentType: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, body: "invalid JSON" },
		{ status: 200, contentType: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, body: "{}" },
	])(
		"does not classify HTTP $status or invalid manifest responses as transport-only",
		async ({ status, contentType, body }) => {
			const paths = healthyAppliedRuntimePaths();
			const applied = readRuntimeAppliedState(paths);
			const identity = applied ? runtimeAppliedApplyIdentity(applied) : null;
			if (!identity) throw new Error("Expected applied fixture");
			globalThis.fetch = Object.assign(
				async () =>
					new Response(body, {
						status,
						headers: { "content-type": contentType, etag: '"response"' },
					}),
				{ preconnect: () => undefined },
			);
			const failure = await loadRemoteRuntimeManifest(paths, {
				applyContext: {
					kind: "context-file",
					backend: "incus",
					identity,
					manifestSource: {
						type: "http",
						url: "https://runtime.example.test/manifest",
						auth: { type: "bearer", token: "fixture" },
					},
				},
			});
			if (!("errors" in failure)) throw new Error("Expected rejected response");
			expect(failure).not.toHaveProperty("failureKind");
			const event = runtimeWatchEventForOutcome({ kind: "load_failed", failure }, paths);
			if (!event) throw new Error("Expected watch error");
			expect(event).not.toHaveProperty("healthImpact");
			writeRuntimeWatchStatus(event, paths);
			expect((await readHostedRuntimeObserved(paths))?.status).toBe("error");
		},
	);

	test("reports committed provider conflicts without degrading runtime health", async () => {
		const paths = healthyAppliedRuntimePaths();
		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("Missing applied state fixture");
		const entries = runtimeProviderConflicts([
			{ runtime: "openclaw", providerId: "banban", code: "native_provider_exists" },
			{ runtime: "hermes", providerId: "banban", code: "native_credential_pool_conflict" },
			{ runtime: "hermes", providerId: "Not A Wire ID", code: "native_provider_exists" },
		]);
		expect(entries.map(({ runtime }) => runtime)).toEqual(["hermes", "openclaw"]);
		expect(() =>
			writeRuntimeAppliedState({ ...applied, providerConflicts: [...entries].reverse() }, paths),
		).toThrow("unique and sorted");
		writeRuntimeAppliedState({ ...applied, providerConflicts: entries }, paths);
		writeRuntimeWatchStatus({ status: "applied", stage: "final" }, paths);

		expect(await readHostedRuntimeObserved(paths)).not.toHaveProperty("providerConflicts");
		const observed = await readHostedRuntimeObserved(paths, { includeProviderConflicts: true });
		expect(observed?.status).toBe("ok");
		expect(observed?.convergeError).toBeUndefined();
		expect(observed?.providerConflicts).toEqual({ schemaVersion: 1, entries });
	});

	test("reports committed service withdrawals without degrading runtime health", async () => {
		const paths = healthyAppliedRuntimePaths();
		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("Missing applied state fixture");
		const entries = runtimeServiceWithdrawals([
			{ runtime: "openclaw", service: "dashboard" },
			{ runtime: "hermes", service: "dashboard" },
			{ runtime: "hermes", service: "dashboard" },
			{ runtime: "hermes", service: "gateway" },
		]);
		expect(entries).toEqual([
			{ runtime: "hermes", service: "dashboard" },
			{ runtime: "openclaw", service: "dashboard" },
		]);
		expect(() =>
			writeRuntimeAppliedState({ ...applied, serviceWithdrawals: [...entries].reverse() }, paths),
		).toThrow("unique and sorted");
		expect(() => writeRuntimeAppliedState({ ...applied, serviceWithdrawals: [] }, paths)).toThrow();
		writeRuntimeAppliedState({ ...applied, serviceWithdrawals: entries }, paths);
		writeRuntimeWatchStatus({ status: "applied", stage: "final" }, paths);

		expect(await readHostedRuntimeObserved(paths)).not.toHaveProperty("serviceWithdrawals");
		const observed = await readHostedRuntimeObserved(paths, { includeServiceWithdrawals: true });
		expect(observed?.status).toBe("ok");
		expect(observed?.convergeError).toBeUndefined();
		expect(observed?.serviceWithdrawals).toEqual({ schemaVersion: 1, entries });

		// A later healthy generation commits without the field and stops reporting it.
		writeRuntimeAppliedState(applied, paths);
		expect(
			await readHostedRuntimeObserved(paths, { includeServiceWithdrawals: true }),
		).not.toHaveProperty("serviceWithdrawals");
	});

	test("reports durable Hermes user activity through the existing observation contract", async () => {
		const paths = healthyAppliedRuntimePaths(["hermes"]);
		process.env.CLAWDI_STATE_DIR = join(paths.serviceStateRoot, "activity");
		recordRuntimeUserActivityScan({
			agentType: "hermes",
			userActivity: {
				lastUserInputAt: "2026-08-19T01:00:00.000Z",
				complete: true,
			},
			complete: true,
			observedAt: new Date("2026-08-19T02:00:00.000Z"),
		});

		expect(await readHostedRuntimeObserved(paths)).not.toHaveProperty("userActivity");
		expect(
			(await readHostedRuntimeObserved(paths, { includeUserActivity: true }))?.userActivity,
		).toEqual({
			schemaVersion: 1,
			classifierVersion: 1,
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-19T01:00:00.000Z",
			observedAt: "2026-08-19T02:00:00.000Z",
			completeAt: "2026-08-19T02:00:00.000Z",
			enabledRuntimes: ["hermes"],
		});
	});

	test("reports an untyped watch apply failure as unhealthy", async () => {
		const paths = healthyAppliedRuntimePaths();
		writeRuntimeWatchStatus(
			{
				status: "error",
				stage: "final",
				error: "runtime apply failed",
			},
			paths,
		);

		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("error");
		expect(observed?.convergeError).toBe("runtime apply failed");
	});

	test.each([
		{
			runtime: "openclaw",
			unit: "openclaw-gateway.service",
			ready: { ready: true },
			pending: [{ ready: false }, { ok: true }],
		},
		{
			runtime: "hermes",
			unit: "clawdi-hermes-dashboard.service",
			ready: {
				gateway_running: true,
				gateway_state: "running",
				auth_required: true,
				auth_providers: ["self-hosted"],
			},
			pending: [
				{
					gateway_running: true,
					gateway_state: "starting",
					auth_required: true,
					auth_providers: ["self-hosted"],
				},
				{
					gateway_running: false,
					gateway_state: "running",
					auth_required: true,
					auth_providers: ["self-hosted"],
				},
				{
					gateway_running: true,
					gateway_state: "running",
					auth_required: false,
					auth_providers: [],
				},
			],
		},
	])(
		"requires $runtime serving readiness after systemd activation",
		async ({ runtime, unit, ready, pending }) => {
			const paths = healthyAppliedRuntimePaths([runtime]);
			const identity = userInfo();
			process.env.CLAWDI_RUNTIME_USER = identity.username;
			// Bun's username follows USER; numeric credentials identify the actual test process.
			process.env.CLAWDI_RUNTIME_UID = String(identity.uid);
			process.env.CLAWDI_RUNTIME_GID = String(identity.gid);
			mkdirSync(paths.systemdUserRoot, { recursive: true });
			writeFileSync(join(paths.systemdUserRoot, unit), GENERATED_RUNTIME_SYSTEMD_FILE_HEADER);
			const gatewayUnit = join(paths.systemdUserRoot, "hermes-gateway.service");
			const hermesConfigPath = join(paths.userHome, ".hermes", "config.yaml");
			const writeHermesAuthProvider = () => {
				mkdirSync(dirname(hermesConfigPath), { recursive: true });
				writeFileSync(
					hermesConfigPath,
					"dashboard:\n  oauth:\n    self_hosted:\n      issuer: https://api.example.test/v2/hermes/oidc\n      client_id: test\n",
				);
			};

			if (unit === "clawdi-hermes-dashboard.service") {
				writeFileSync(gatewayUnit, GENERATED_RUNTIME_SYSTEMD_FILE_HEADER);
				writeHermesAuthProvider();
			}
			const systemctl = join(paths.userHome, "systemctl");
			writeFileSync(
				systemctl,
				"#!/bin/sh\nprintf 'ActiveState=active\nSubState=running\nLoadState=loaded\nNeedDaemonReload=no\nJob=\nInvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'\n",
				{
					mode: 0o700,
				},
			);
			process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
			let body: unknown = ready;
			let mutateParent: (() => void) | undefined;
			let uiStatus = 200;
			let probeStatus = 200;
			let nativeStatus: unknown;
			let probeWait: Promise<void> | undefined;
			let releaseProbe: (() => void) | undefined;
			let statusRequests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: unit === "openclaw-gateway.service" ? 0 : 9119,
				async fetch(request) {
					if (probeWait) await probeWait;
					const mutate = mutateParent;
					mutateParent = undefined;
					mutate?.();
					const path = new URL(request.url).pathname;
					if (path === "/api/status") statusRequests++;
					if (path === "/native-status")
						return new Response(
							typeof nativeStatus === "string" ? nativeStatus : JSON.stringify(nativeStatus),
						);
					if (path === "/" && request.method === "HEAD") return new Response(null, { status: 405 });
					if (path === "/")
						return new Response(null, { status: 302, headers: { Location: "/login" } });
					if (path === "/login" || path === "/control/")
						return new Response("<!doctype html><html></html>", {
							status: uiStatus,
							headers: { "Content-Type": "text/html" },
						});
					if (path !== "/readyz" && path !== "/api/status")
						return new Response(null, { status: 404 });
					return new Response(typeof body === "string" ? body : JSON.stringify(body), {
						status: probeStatus,
					});
				},
			});
			const configPath = join(paths.userHome, ".openclaw", "openclaw.json");
			mkdirSync(dirname(configPath), { recursive: true });
			const config = `{ // Native OpenClaw configuration supports JSON5.
  gateway: { port: ${server.port}, controlUi: { basePath: '/control' } },
}`;
			writeFileSync(configPath, config);
			try {
				for (const response of [...pending, null, "not JSON", ready, ...pending]) {
					body = response;
					statusRequests = 0;
					const observed = await readHostedRuntimeObserved(paths);
					expect(
						observed?.systemd?.units.find((candidate) => candidate.name === unit)?.activeState,
					).toBe("active");
					expect(observed?.status).toBe(response === ready ? "ok" : "unknown");
					if (runtime === "hermes") {
						expect(statusRequests).toBe(1);
						if (response === pending[0] || response === pending[1]) {
							expect(
								observed?.systemd?.units.find((candidate) => candidate.name === unit)?.status,
							).toBe("unknown");
							expect(
								observed?.systemd?.units.find(
									(candidate) => candidate.name === "hermes-gateway.service",
								),
							).toMatchObject({
								status: "ok",
							});
						}
					}
				}
				body = ready;
				const idleWatch = {
					schemaVersion: "clawdi.runtimeWatchStatus.v1",
					event: { status: "not_modified" },
					timestamp: "2026-09-12T00:00:00.000Z",
				};
				writeFileSync(paths.runtimeWatchStatus, JSON.stringify(idleWatch));
				mutateParent = () =>
					writeFileSync(
						paths.runtimeWatchStatus,
						JSON.stringify({ ...idleWatch, timestamp: "2026-09-12T00:00:15.000Z" }),
					);
				expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
				const parent = readRuntimeAppliedState(paths);
				if (!parent) throw new Error("Expected applied fixture");
				mutateParent = () =>
					writeRuntimeAppliedState({ ...parent, appliedAt: "2026-09-12T12:00:00.000Z" }, paths);
				expect(await readHostedRuntimeObserved(paths)).toBeNull();
				writeRuntimeAppliedState(parent, paths);
				mutateParent = () =>
					writeFileSync(
						paths.runtimeWatchStatus,
						JSON.stringify({ event: { status: "error", error: "apply failed during probe" } }),
					);
				expect(await readHostedRuntimeObserved(paths)).toBeNull();
				rmSync(paths.runtimeWatchStatus);
				probeStatus = 503;
				const unavailable = await readHostedRuntimeObserved(paths);
				expect(unavailable?.status).toBe("unknown");
				if (runtime === "hermes")
					expect(
						unavailable?.systemd?.units.find((candidate) => candidate.name === unit)?.error,
					).toBe("Runtime readiness probe: HTTP 503");
				probeStatus = 200;
				if (unit === "openclaw-gateway.service") {
					// The old native status command proves handshake admission independently of channels.
					mkdirSync(paths.userLocalBin, { recursive: true });
					const statusCommand = join(paths.userLocalBin, "openclaw");
					writeFileSync(
						statusCommand,
						`#!/bin/sh
[ "$*" = "gateway status --json --timeout 3000" ] || exit 1
[ "$OPENCLAW_CONFIG_PATH" = "$HOME/.openclaw/openclaw.json" ] || exit 1
exec curl --disable --noproxy '*' --fail --silent http://127.0.0.1:${server.port}/native-status
`,
						{ mode: 0o700 },
					);
					const connected = {
						rpc: {
							ok: true,
							kind: "connect",
							capability: "connected_no_operator_scope",
							auth: { role: "operator", scopes: [] },
							url: `ws://127.0.0.1:${server.port}`,
						},
					};
					body = { ready: false, failing: ["telegram"], eventLoop: { degraded: false } };
					probeStatus = 503;
					for (const response of [
						connected,
						{ rpc: { ok: false } },
						{ rpc: { ...connected.rpc, url: "ws://other.example.test:18789" } },
						{ ok: true },
						null,
						"not JSON",
						connected,
					]) {
						nativeStatus = response;
						expect((await readHostedRuntimeObserved(paths))?.status).toBe(
							response === connected ? "ok" : "unknown",
						);
					}
					uiStatus = 503;
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					uiStatus = 200;
					probeStatus = 200;
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					probeStatus = 503;
					for (const invalid of [
						{ ready: false, failing: ["gateway-draining"] },
						{ ready: false, failing: [] },
						{ ready: false, failing: [null] },
						{ ok: true },
						"<html>Control UI</html>",
					]) {
						body = invalid;
						expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					}
					body = { ready: false, failing: ["startup-sidecars"] };
					// Official startup admission returns a failed native handshake, even with a serving UI.
					nativeStatus = { rpc: { ok: false } };
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					rmSync(statusCommand);
					body = ready;
					probeStatus = 200;
					for (const status of [503, 404, 302, 200]) {
						uiStatus = status;
						expect((await readHostedRuntimeObserved(paths))?.status).toBe(
							status === 200 ? "ok" : "unknown",
						);
					}
					// An absent or stale optional manifest cache must not override native configuration.
					mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
					writeFileSync(
						paths.manifestLastGood,
						JSON.stringify({ manifest: { system: { openclawControlUiBasePath: "/stale" } } }),
					);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
					for (const invalid of ["{}", "not JSON"]) {
						writeFileSync(configPath, invalid);
						expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					}
					rmSync(configPath);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					// Native includes are resolved by OpenClaw's existing config command contract.
					mkdirSync(paths.userLocalBin, { recursive: true });
					const nativeCommand = join(paths.userLocalBin, "openclaw");
					writeFileSync(
						nativeCommand,
						`#!/bin/sh
[ "$*" = "config get gateway --json" ] || exit 1
[ "$OPENCLAW_CONFIG_PATH" = "$HOME/.openclaw/openclaw.json" ] || exit 1
printf '%s' '{"port":${server.port},"controlUi":{"basePath":"/control"}}'
`,
						{ mode: 0o700 },
					);
					for (const included of [
						{ $include: "native.json" },
						{ gateway: { $include: "gateway.json" } },
						{ gateway: { port: server.port, controlUi: { $include: "ui.json" } } },
					]) {
						writeFileSync(configPath, JSON.stringify(included));
						expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
					}
					rmSync(nativeCommand);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					writeFileSync(configPath, config);
					// An HTTP server that accepts but never replies must not freeze observation.
					probeWait = new Promise<void>((resolve) => {
						releaseProbe = resolve;
					});
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
				} else {
					body = {
						gateway_running: false,
						gateway_state: "stopped",
						auth_required: true,
						auth_providers: ["self-hosted"],
					};
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(true);
					writeFileSync(hermesConfigPath, "dashboard: {}\n");
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(false);
					writeHermesAuthProvider();
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(true);
					body = {
						gateway_running: false,
						gateway_state: "stopped",
						auth_required: true,
						auth_providers: ["self-hosted", "nous"],
					};
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(false);
					writeHermesAuthProvider();
					body = {
						gateway_running: false,
						gateway_state: "stopped",
						auth_required: true,
						auth_providers: ["self-hosted"],
					};
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(true);
					uiStatus = 503;
					expect(await runtimeComponentIsReady("hermes-ui", paths)).toBe(false);
					const missingLogin = await readHostedRuntimeObserved(paths);
					expect(
						missingLogin?.systemd?.units.find((candidate) => candidate.name === unit)?.error,
					).toBe("Runtime readiness probe: HTTP 503");
					uiStatus = 200;
					body = ready;
					probeWait = new Promise<void>((resolve) => {
						releaseProbe = resolve;
					});
					const timedOut = await readHostedRuntimeObserved(paths);
					expect(timedOut?.status).toBe("unknown");
					expect(timedOut?.systemd?.units.find((candidate) => candidate.name === unit)?.error).toBe(
						"Runtime readiness probe: timeout (3000ms)",
					);
					releaseProbe?.();
					probeWait = undefined;
					writeFileSync(
						systemctl,
						`#!/bin/sh
case "$*" in
  *hermes-gateway.service*) printf 'ActiveState=activating\\nSubState=start\\n' ;;
  *) printf 'ActiveState=active\\nSubState=running\\n' ;;
esac
`,
						{ mode: 0o700 },
					);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
				}
			} finally {
				releaseProbe?.();
				await server.stop(true);
			}
			expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
		},
	);

	test("requires boot-selected services when the receipt has no activation inventory", async () => {
		const paths = healthyAppliedRuntimePaths(["hermes"]);
		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("unknown");
		expect(observed?.systemd?.units.map((unit) => unit.name)).toEqual([
			"clawdi-hermes-dashboard.service",
			"hermes-gateway.service",
		]);
	});

	test("keeps missing and truncated applied services from reporting healthy", async () => {
		const paths = healthyAppliedRuntimePaths();
		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("Fixture is missing applied state");
		writeRuntimeAppliedState(
			{ ...applied, activated: { "hermes-gateway.service": "a".repeat(64) } },
			paths,
		);
		const identity = userInfo();
		process.env.CLAWDI_RUNTIME_USER = identity.username;
		process.env.CLAWDI_RUNTIME_UID = String(identity.uid);
		process.env.CLAWDI_RUNTIME_GID = String(identity.gid);
		mkdirSync(paths.userHome, { recursive: true });
		const systemctl = join(paths.userHome, "systemctl");
		writeFileSync(
			systemctl,
			`#!/bin/sh
case "$*" in
  *hermes-gateway.service*) printf 'ActiveState=inactive\\nSubState=dead\\n' ;;
  *) printf 'ActiveState=active\\nSubState=running\\n' ;;
esac
`,
			{ mode: 0o700 },
		);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const missing = await readHostedRuntimeObserved(paths);
		expect(missing?.status).toBe("unknown");
		expect(missing?.systemd?.units).toMatchObject([
			{ name: "hermes-gateway.service", activeState: "inactive" },
		]);
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		for (let index = 0; index < 31; index += 1) {
			writeFileSync(
				join(paths.systemdUserRoot, `clawdi-extra-${index}.service`),
				GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
			);
		}
		const truncated = await readHostedRuntimeObserved(paths);
		expect(truncated?.truncated).toBe(true);
		expect(truncated?.systemd?.units.some((unit) => unit.name === "hermes-gateway.service")).toBe(
			false,
		);
		expect(truncated?.status).toBe("unknown");
	});

	test("reports complete systemd counts with representative scoped truncation", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-truncation-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_RUNTIME_USER = userInfo().username;
		process.env.CLAWDI_RUNTIME_UID = String(userInfo().uid);
		process.env.CLAWDI_RUNTIME_GID = String(userInfo().gid);
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "systemd");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		const systemctl = join(root, "systemctl");
		writeFileSync(systemctl, "#!/bin/sh\nprintf 'ActiveState=active\\nSubState=running\\n'\n");
		chmodSync(systemctl, 0o700);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		for (let index = 0; index < 31; index += 1) {
			const suffix = index.toString().padStart(2, "0");
			writeFileSync(join(paths.systemdSystemRoot, `clawdi-system-${suffix}.service`), "");
			writeFileSync(join(paths.systemdUserRoot, `clawdi-user-${suffix}.service`), "");
		}

		const observed = await readHostedRuntimeObserved(paths);

		expect(observed?.truncated).toBe(true);
		expect(observed?.systemd?.unitCount).toBe(62);
		expect(observed?.systemd?.units).toHaveLength(30);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "system")).toHaveLength(15);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "user")).toHaveLength(15);
	});
});

test.each(["hermes", "openclaw"] as const)(
	"shares one identity-bound %s serving sample with component proof",
	async (runtime) => {
		const paths = healthyAppliedRuntimePaths([runtime]);
		const originalBoot = readRuntimeBootStatus(paths).status;
		if (!originalBoot) throw new Error("Expected boot fixture");
		const identity = userInfo();
		process.env.CLAWDI_RUNTIME_USER = identity.username;
		process.env.CLAWDI_RUNTIME_UID = String(identity.uid);
		process.env.CLAWDI_RUNTIME_GID = String(identity.gid);
		const component = runtime === "hermes" ? "hermes-ui" : "openclaw-ui";
		const unit =
			runtime === "hermes" ? "clawdi-hermes-dashboard.service" : "openclaw-gateway.service";
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(
			join(paths.systemdUserRoot, unit),
			`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/fixture\n`,
		);
		const invocationPath = join(paths.userHome, "invocation");
		const managerConfigPath = join(paths.userHome, "manager-config");
		const nativeConfigPath = join(
			paths.userHome,
			runtime === "hermes" ? ".hermes/config.yaml" : ".openclaw/openclaw.json",
		);
		const nativeConfig =
			runtime === "hermes"
				? "dashboard:\n  oauth:\n    self_hosted:\n      client_id: fixture\n"
				: JSON.stringify({ gateway: { port: 18789, auth: { token: "fixture" } } });
		mkdirSync(dirname(nativeConfigPath), { recursive: true });
		let resetDesiredConfiguration = () => {};
		const resetConfiguration = () => {
			writeFileSync(invocationPath, "a".repeat(32));
			writeFileSync(managerConfigPath, "fixture-effective-unit");
			writeFileSync(nativeConfigPath, nativeConfig);
			resetDesiredConfiguration();
		};
		resetConfiguration();
		if (runtime === "hermes") {
			const runPath = runtimeRunConfigPath("hermes", paths, "dashboard");
			mkdirSync(dirname(runPath), { recursive: true });
			resetDesiredConfiguration = () =>
				writeFileSync(
					runPath,
					JSON.stringify({
						schemaVersion: "clawdi.runtimeRunConfig.v1",
						runtime: "hermes",
						service: "dashboard",
						enabled: true,
						generatedAt: "2026-09-29T00:00:00Z",
						generation: 1,
						instanceId: "fixture",
						command: "hermes",
						commandPath: null,
						appRoot: null,
					}),
				);
			resetDesiredConfiguration();
		}
		const systemctl = join(paths.userHome, "systemctl");
		writeFileSync(
			systemctl,
			`#!/bin/sh
[ "$1" = --user ] && shift
if [ "$1" = cat ]; then cat '${managerConfigPath}'; exit 0; fi
printf 'ActiveState=active\nSubState=running\nLoadState=loaded\nNeedDaemonReload=no\nJob=\nInvocationID='
cat '${invocationPath}'
printf '\n'
`,
			{ mode: 0o700 },
		);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const applied = readRuntimeAppliedState(paths);
		const fingerprint = readSystemdComponentFingerprint(paths, "user", unit);
		if (!applied || !fingerprint) throw new Error("Expected service fixture");
		applied.activated = { [unit]: fingerprint };
		writeRuntimeAppliedState(applied, paths);
		const identityForFetch = runtimeAppliedApplyIdentity(applied);
		if (!identityForFetch) throw new Error("Expected apply identity");
		const transportEvent = runtimeWatchEventForOutcome(
			{
				kind: "load_failed",
				failure: {
					mode: "repair",
					stage: "network",
					errors: ["could not fetch runtime manifest: fetch failed"],
					failureKind: "transport",
					requestedApplyIdentity: identityForFetch,
				},
			},
			paths,
		);
		if (!transportEvent) throw new Error("Expected watch event");
		writeRuntimeWatchStatus(transportEvent, paths);
		const manager = readComponentServiceState(paths, "user", unit);
		const config = componentConfigurationRevision(component, paths, fingerprint);
		if (!manager || !config) throw new Error("Expected bound component fixture");
		writeFileSync(
			join(dirname(paths.appliedState), "component-activations.json"),
			JSON.stringify({
				schemaVersion: 1,
				appliedStateRevision: runtimeContentSha256(applied),
				entries: [
					{
						component,
						invocationId: manager.invocationId,
						configRevision: runtimeContentSha256([config, manager.configurationRevision]),
						accessRevision: "b".repeat(64),
					},
				],
			}),
		);
		let requests = 0;
		let releaseTimedOutRequest: (() => void) | undefined;
		let mode:
			| "healthy"
			| "http-failure"
			| "invalid-json"
			| "boot-change"
			| "timeout"
			| "restart"
			| "native-config"
			| "desired-config"
			| "unit-config" = "healthy";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: runtime === "hermes" ? 9119 : 18789,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/login" || path === "/") return new Response("<!doctype html><html></html>");
				if (path !== "/api/status" && path !== "/readyz")
					return new Response(null, { status: 404 });
				requests++;
				// A second independent probe would succeed and contradict the first.
				if (requests === 1) {
					if (mode === "http-failure") return new Response("unavailable", { status: 503 });
					if (mode === "invalid-json") return new Response("not JSON");
					if (mode === "boot-change")
						writeRuntimeBootStatus({ ...originalBoot, bootId: "changed-boot" }, paths);
					if (mode === "timeout")
						await new Promise<void>((resolve) => {
							releaseTimedOutRequest = resolve;
						});
					if (mode === "restart") writeFileSync(invocationPath, "c".repeat(32));
					if (mode === "native-config")
						writeFileSync(nativeConfigPath, `${nativeConfig}\n# changed\n`);
					if (mode === "unit-config") writeFileSync(managerConfigPath, "changed-effective-unit");
					if (mode === "desired-config")
						writeFileSync(runtimeRunConfigPath("hermes", paths, "dashboard"), "{}");
				}
				return Response.json(
					runtime === "hermes"
						? {
								gateway_running: true,
								gateway_state: "running",
								auth_required: true,
								auth_providers: ["self-hosted"],
							}
						: { ready: true },
				);
			},
		});
		try {
			for (const nextMode of [
				"healthy",
				"http-failure",
				"invalid-json",
				"timeout",
				"restart",
				"native-config",
				"unit-config",
				...(runtime === "hermes" ? ["desired-config" as const] : []),
				"healthy",
			] as const) {
				resetConfiguration();
				mode = nextMode;
				requests = 0;
				const observed = await readHostedRuntimeObserved(paths, { includeComponents: true });
				releaseTimedOutRequest?.();
				releaseTimedOutRequest = undefined;
				expect(requests).toBe(1);
				const expected = mode === "healthy" ? "ok" : "unknown";
				expect({ mode, status: observed?.status }).toEqual({ mode, status: expected });
				expect(observed?.systemd?.units.find((entry) => entry.name === unit)?.status).toBe(
					expected,
				);
				expect(observed?.components?.entries[0]?.status).toBe(expected);
			}
			resetConfiguration();
			mode = "boot-change";
			requests = 0;
			expect(await readHostedRuntimeObserved(paths, { includeComponents: true })).toBeNull();
			expect(requests).toBe(1);
		} finally {
			releaseTimedOutRequest?.();
			await server.stop(true);
		}
	},
);

test("unknown component evidence downgrades healthy aggregate without replacing a definite error", async () => {
	const paths = healthyAppliedRuntimePaths();
	const applied = readRuntimeAppliedState(paths);
	if (!applied) throw new Error("Expected applied fixture");
	applied.etag = `"sha256:${applied.sourceRevision}"`;
	writeRuntimeAppliedState(applied, paths);
	writeFileSync(
		join(dirname(paths.appliedState), "component-activations.json"),
		JSON.stringify({
			schemaVersion: 1,
			appliedStateRevision: runtimeContentSha256(applied),
			entries: [
				{
					component: "files",
					configRevision: "a".repeat(64),
					accessRevision: "b".repeat(64),
					invocationId: "c".repeat(32),
				},
			],
		}),
	);
	expect(await readHostedRuntimeObserved(paths)).not.toHaveProperty("components");
	const unavailable = await readHostedRuntimeObserved(paths, { includeComponents: true });
	expect(unavailable?.components?.entries[0]?.status).toBe("unknown");
	expect(unavailable?.status).toBe("unknown");
	const companion = new HostedRuntimeHeartbeatSession({
		environmentId: "fixture-component",
		paths,
	});
	expect((await companion.nextEvent())?.event.components?.entries[0]?.status).toBe("unknown");
	writeFileSync(
		paths.runtimeWatchStatus,
		JSON.stringify({ event: { status: "error", error: "required apply failed" } }),
	);
	expect((await readHostedRuntimeObserved(paths, { includeComponents: true }))?.status).toBe(
		"error",
	);
});
