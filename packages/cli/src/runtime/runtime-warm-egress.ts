import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { egressEngineSchema } from "./egress-engine";
import { buildEgressEngineEnv } from "./egress-env";
import { publishEgressSystemCaBundle } from "./egress-sidecar";
import { initializeAnonymousEgressSnapshot, recordWarmEgress } from "./egress-snapshot";
import {
	makeEgressIdentityPrivateDir,
	writeEgressAddon,
	writeEgressProfileBundle,
	writeTransparentEgressEnvFile,
} from "./manifest-egress";
import { egressSecretFilePath, makeManagedSecretRoot } from "./manifest-secrets";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import { preinstallationSpecSchema } from "./preinstallation";
import {
	type RuntimeEgressSystemdProgram,
	runtimeSystemdCommonEnvironment,
	writeRuntimeSidecarSystemdUnit,
} from "./runtime-systemd-reconciliation";
import {
	buildNumericUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
} from "./runtime-user-command";
import { ensureRuntimePlatformDirectory, writeRuntimePlatformFileAtomic } from "./state";
import { TRANSPARENT_EGRESS_PORT } from "./transparent-egress";

const EGRESS_CA_TIMEOUT_MS = 30_000;

/** Let the pinned engine create this instance's CA; the sidecar reuses it later. */
export async function generateAnonymousEgressCa(
	paths: RuntimePaths,
	runtimeGid: number,
): Promise<void> {
	const receipt = preinstallationSpecSchema
		.passthrough()
		.parse(
			JSON.parse(
				readFileSync(join(paths.serviceStateRoot, "preinstallation", "receipt.json"), "utf8"),
			),
		);
	const egressEngine = egressEngineSchema.safeParse(receipt.egressEngine);
	if (!egressEngine.success) return;
	const engine = ensureRuntimeMitmproxy(egressEngine.data, paths);
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
				await sleep(1_000);
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

/** Start a tenant-free, fail-closed engine; claim supplies one atomic snapshot. */
export function warmAnonymousEgressSidecar(
	paths: RuntimePaths,
	identity: { uid: number; gid: number },
): void {
	initializeAnonymousEgressSnapshot(paths);
	const receipt = preinstallationSpecSchema
		.passthrough()
		.parse(
			JSON.parse(
				readFileSync(join(paths.serviceStateRoot, "preinstallation", "receipt.json"), "utf8"),
			),
		);
	const egressEngine = egressEngineSchema.safeParse(receipt.egressEngine);
	if (!egressEngine.success) return;
	const engine = ensureRuntimeMitmproxy(egressEngine.data, paths);
	if (engine.status !== "ready") throw new Error("prepared egress engine is unavailable");
	const profileBundlePath = writeEgressProfileBundle(
		{ schemaVersion: "clawdi.egressProfiles.v1", profiles: [] },
		paths,
	);
	ensureRuntimePlatformDirectory(paths, paths.managedSecretRoot, { mode: 0o711 });
	makeManagedSecretRoot(paths.managedSecretRoot);
	const secretFilePath = egressSecretFilePath(paths);
	writeRuntimePlatformFileAtomic(paths, secretFilePath, "{}\n", { mode: 0o640, dirMode: 0o711 });
	const addon = writeEgressAddon(paths);
	const program: RuntimeEgressSystemdProgram = {
		profileBundlePath,
		secretFilePath,
		engine,
		envFilePath: paths.egressTransparentEnv,
		transparentPort: TRANSPARENT_EGRESS_PORT,
		addonPath: addon.path,
		addonSha256: addon.sha256,
		systemCaBundle: paths.egressSystemCaFile,
	};
	const egressIdentity = {
		runtimeUid: identity.uid,
		runtimeGid: identity.gid,
		egressUid: runtimeEgressUid(),
		egressGid: runtimeEgressGid(),
	};
	writeTransparentEgressEnvFile({ program, paths, runtimeUser: "clawdi", ...egressIdentity });
	const unit = basename(
		writeRuntimeSidecarSystemdUnit({
			program,
			identity: egressIdentity,
			paths,
			workspaceRoot: paths.workspaceRoot,
			commonEnvironment: runtimeSystemdCommonEnvironment(paths),
		}),
	);
	for (const args of [["daemon-reload"], ["enable", "--runtime", unit], ["restart", unit]]) {
		const result = spawnSync("systemctl", args, { stdio: "ignore", timeout: 60_000 });
		if (result.status !== 0) throw new Error("anonymous egress sidecar did not start");
	}
	recordWarmEgress(paths);
}
