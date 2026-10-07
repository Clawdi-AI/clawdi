import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { reconcilePendingRuntimeCliUpgrade } from "./cli-update";
import { initializeAnonymousEgressSnapshot } from "./egress-snapshot";
import { resolveHostedOpenClawWorkspace } from "./hosted-openclaw-context";
import { runtimeCommandPath } from "./manifest-install";
import {
	anonymousOpenClawGatewayPatch,
	seedAnonymousOpenClawAuthProbes,
} from "./openclaw-preinstallation";
import { applyOpenClawConfigMergePatch } from "./openclaw-provider-config";
import { recordWarmOpenClawGateway, warmOpenClawGatewayEnvironment } from "./openclaw-warm-gateway";
import type { RuntimePaths } from "./paths";
import {
	flushPersistedStepRevisions,
	loadPersistedStepRevisions,
} from "./persisted-step-revisions";
import { installAnonymousOpenClawGatewayService } from "./runtime-systemd-reconciliation";
import { runtimeUserGid, runtimeUserUid } from "./runtime-user-command";
import { generateAnonymousEgressCa, warmAnonymousEgressSidecar } from "./runtime-warm-egress";

const GATEWAY_READY_TIMEOUT_MS = 180_000;

/** Warm anonymous gateway/egress and seed probes before single-use adoption. */
export async function warmHostedOpenClawRuntime(
	paths: RuntimePaths,
	runtimeUser = "clawdi",
): Promise<void> {
	if (paths.mode !== "hosted") throw new Error("runtime warm requires hosted runtime mode");
	if (
		[
			paths.runtimeContextFile,
			paths.appliedState,
			paths.manifestLastGood,
			paths.managedSecretCacheFile,
		].some(existsSync)
	)
		throw new Error("runtime warm requires an unclaimed runtime with no applied tenant state");
	initializeAnonymousEgressSnapshot(paths);
	// Verify the managed CLI from this instance before the claim shim.
	reconcilePendingRuntimeCliUpgrade(paths);
	const command = runtimeCommandPath("openclaw", paths.userHome);
	if (!command) throw new Error("OpenClaw is not installed");
	const sdk = resolveOpenClawSdkExport(
		paths.userHome,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.configMutation,
	);
	if (!sdk) throw new Error("OpenClaw config-mutation SDK export is unavailable");
	const identity = { uid: runtimeUserUid(runtimeUser), gid: runtimeUserGid(runtimeUser) };
	const manager = spawnSync("systemctl", ["start", `user@${identity.uid}.service`], {
		stdio: "ignore",
		timeout: 60_000,
	});
	if (manager.status !== 0) throw new Error("runtime user manager did not start");
	mkdirSync(paths.runRoot, { recursive: true, mode: 0o711 });
	await generateAnonymousEgressCa(paths, identity.gid);

	loadPersistedStepRevisions(paths);
	const patch = anonymousOpenClawGatewayPatch(randomBytes(32).toString("base64url"));
	applyOpenClawConfigMergePatch(sdk, JSON.stringify(patch), paths.userHome, paths.userHome);
	const unit = installAnonymousOpenClawGatewayService(
		paths,
		identity,
		warmOpenClawGatewayEnvironment(paths),
	);
	const start = spawnSync("systemctl", ["--user", "-M", `${runtimeUser}@`, "start", unit], {
		stdio: "ignore",
		timeout: 120_000,
	});
	if (start.status !== 0) throw new Error("anonymous OpenClaw gateway did not start");
	await waitForGatewayHealth();
	warmAnonymousEgressSidecar(paths, identity);

	// The gateway has created its state; seed what the first apply would probe.
	resolveHostedOpenClawWorkspace(paths.userHome);
	seedAnonymousOpenClawAuthProbes(paths, command);
	flushPersistedStepRevisions(paths);
	recordWarmOpenClawGateway(paths);
}

async function waitForGatewayHealth(): Promise<void> {
	const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch("http://127.0.0.1:18789/healthz", {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await sleep(1_000);
	}
	throw new Error("anonymous OpenClaw gateway did not become healthy");
}
