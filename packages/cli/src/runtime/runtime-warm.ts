import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { buildEgressEngineEnv } from "./egress-env";
import { publishEgressSystemCaBundle } from "./egress-sidecar";
import { resolveHostedOpenClawWorkspace } from "./hosted-openclaw-context";
import { makeEgressIdentityPrivateDir } from "./manifest-egress";
import { runtimeCommandPath } from "./manifest-install";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
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
import { preinstallationSpecSchema } from "./preinstallation";
import { installAnonymousOpenClawGatewayService } from "./runtime-systemd-reconciliation";
import {
	buildNumericUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
	runtimeUserGid,
	runtimeUserUid,
} from "./runtime-user-command";
import { ensureRuntimePlatformDirectory, writeRuntimePlatformFileAtomic } from "./state";

const EGRESS_CA_TIMEOUT_MS = 30_000;
const GATEWAY_READY_TIMEOUT_MS = 180_000;

/**
 * Pool warm-up for a booted instance that has not been claimed (experimental,
 * default-off). It reads no manifest, credential or tenant identity:
 *
 * 1. generates this instance's egress CA with the pinned engine and publishes
 *    the CA bundle the runtime trusts, so the gateway can start before a tenant;
 * 2. writes the structural gateway settings every hosted tenant uses with a
 *    random instance-local token, plus empty channel containers;
 * 3. installs and starts the official gateway with the environment of a
 *    Clawdi-managed-provider tenant (placeholders and CA paths only);
 * 4. seeds the version-only OpenClaw probes and auth-store discovery;
 * 5. records the gateway's start identity so the first tenant apply can adopt
 *    the running process, and OpenClaw hot-reloads the tenant config.
 */
export async function warmHostedOpenClawRuntime(
	paths: RuntimePaths,
	runtimeUser = "clawdi",
): Promise<void> {
	if (paths.mode !== "hosted") throw new Error("runtime warm requires hosted runtime mode");
	if ([paths.appliedState, paths.manifestLastGood, paths.managedSecretCacheFile].some(existsSync))
		throw new Error("runtime warm requires an unclaimed runtime with no applied tenant state");
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
	await generateEgressCa(paths, identity.gid);

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

	// The gateway has created its state; seed what the first apply would probe.
	resolveHostedOpenClawWorkspace(paths.userHome);
	seedAnonymousOpenClawAuthProbes(paths, command);
	flushPersistedStepRevisions(paths);
	recordWarmOpenClawGateway(paths);
}

/** Let the pinned engine create this instance's CA; the sidecar reuses it later. */
async function generateEgressCa(paths: RuntimePaths, runtimeGid: number): Promise<void> {
	const receipt = preinstallationSpecSchema
		.passthrough()
		.parse(
			JSON.parse(
				readFileSync(join(paths.serviceStateRoot, "preinstallation", "receipt.json"), "utf8"),
			),
		);
	const engine = ensureRuntimeMitmproxy(receipt.egressEngine, paths);
	if (engine.status !== "ready") throw new Error("prepared egress engine is unavailable");
	ensureRuntimePlatformDirectory(paths, paths.egressRoot, { mode: 0o711 });
	chmodSync(paths.egressRoot, 0o711);
	makeEgressIdentityPrivateDir(paths.egressCaDir);
	ensureRuntimePlatformDirectory(paths, dirname(paths.egressSystemCaFile), { mode: 0o711 });
	chmodSync(dirname(paths.egressSystemCaFile), 0o711);
	if (!existsSync(paths.egressCaCert)) {
		// The maintained artifact lives below root-only /var/lib/clawdi. Normal
		// egress uses a systemd read-only bind; anonymous warm-up projects the same
		// verified binary into the traversable runtime root before dropping uid.
		writeRuntimePlatformFileAtomic(
			paths,
			paths.egressServiceBinary,
			readFileSync(engine.binaryPath),
			{
				mode: 0o755,
			},
		);
		const child = buildNumericUserCommand(
			runtimeEgressUid(),
			runtimeEgressGid(),
			paths.egressServiceBinary,
			["--set", `confdir=${paths.egressCaDir}`, "--set", "server=false"],
		);
		const engineProcess = spawn(child.command, child.args, {
			env: buildEgressEngineEnv(process.env, { envFile: "", home: paths.egressCaDir }),
			stdio: ["ignore", "ignore", "pipe"],
		});
		let diagnostic = "";
		let spawnError = false;
		engineProcess.stderr?.on("data", (chunk: Buffer) => {
			diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096);
		});
		engineProcess.once("error", () => {
			spawnError = true;
		});
		const exited = new Promise<void>((resolve) => engineProcess.once("close", () => resolve()));
		try {
			const deadline = Date.now() + EGRESS_CA_TIMEOUT_MS;
			while (!existsSync(paths.egressCaCert)) {
				if (spawnError || engineProcess.exitCode !== null || Date.now() > deadline)
					throw new Error(
						`anonymous egress CA creation failed (${engineProcess.exitCode ?? "timeout"}): ${diagnostic.trim()}`,
					);
				await sleep(100);
			}
		} finally {
			if (engineProcess.exitCode === null) engineProcess.kill("SIGTERM");
			const killTimer = setTimeout(() => engineProcess.kill("SIGKILL"), 2_000);
			try {
				await exited;
			} finally {
				clearTimeout(killTimer);
			}
		}
	}
	publishEgressSystemCaBundle({
		systemCaBundle: paths.egressSystemCaFile,
		caCertPath: paths.egressCaCert,
		runtimeGid,
	});
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
		await sleep(250);
	}
	throw new Error("anonymous OpenClaw gateway did not become healthy");
}
