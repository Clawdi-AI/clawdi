import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildEgressEngineEnv } from "./egress-env";
import { publishEgressSystemCaBundle } from "./egress-sidecar";
import { makeEgressIdentityPrivateDir } from "./manifest-egress";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import type { RuntimePaths } from "./paths";
import { preinstallationSpecSchema } from "./preinstallation";
import {
	buildNumericUserCommand,
	runtimeEgressGid,
	runtimeEgressUid,
} from "./runtime-user-command";
import { ensureRuntimePlatformDirectory, writeRuntimePlatformFileAtomic } from "./state";

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
