import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { reconcilePendingRuntimeCliUpgrade } from "./cli-update";
import { initializeAnonymousEgressSnapshot } from "./egress-snapshot";
import { hermesManagedPython } from "./hermes-python";
import { hermesWarmMarker } from "./hermes-warm-state";
import { runtimeCommandPath } from "./manifest-install";
import type { RuntimePaths } from "./paths";
import { installAnonymousHermesGatewayService } from "./runtime-systemd-reconciliation";
import { runtimeUserGid, runtimeUserUid, spawnRuntimeUserCommand } from "./runtime-user-command";
import { generateAnonymousEgressCa, warmAnonymousEgressSidecar } from "./runtime-warm-egress";
import { writeRuntimePlatformFileAtomic } from "./state";

const COMPILE_TIMEOUT_MS = 600_000;
const ANONYMOUS_DASHBOARD_UNIT = "clawdi-hermes-anonymous-dashboard.service";

/**
 * Pool warm-up for a booted, unclaimed Hermes instance. Only tenant-independent
 * work runs: the official gateway unit is installed exactly as tenant convergence
 * would install it, and the Hermes application tree is byte-compiled so the first
 * gateway and dashboard start after a claim does not compile. The official
 * dashboard is then started on loopback and stopped, completing its first-use
 * local database and dependency work. No tenant manifest, credential or identity
 * is read. The instance-local egress CA is reused on tenant start; tenant OAuth
 * still requires a fresh dashboard process after claim.
 */
export async function warmHostedHermesRuntime(
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
	// A volume copy changes the inode/device identity of the prepared CLI.
	// Refresh its normal verification before the first tenant init needs it.
	reconcilePendingRuntimeCliUpgrade(paths);
	const identity = { uid: runtimeUserUid(runtimeUser), gid: runtimeUserGid(runtimeUser) };
	const manager = spawnSync("systemctl", ["start", `user@${identity.uid}.service`], {
		stdio: "ignore",
		timeout: 60_000,
	});
	if (manager.status !== 0) throw new Error("runtime user manager did not start");
	mkdirSync(paths.runRoot, { recursive: true, mode: 0o711 });
	await generateAnonymousEgressCa(paths, identity.gid);
	const gatewayUnit = installAnonymousHermesGatewayService(paths, identity);
	const appRoot = join(paths.userHome, ".hermes", "hermes-agent");
	const compiled = spawnRuntimeUserCommand(
		hermesManagedPython(paths.userHome),
		["-m", "compileall", "-q", "-j", "0", appRoot],
		paths.userHome,
		paths.userHome,
		{
			maxBufferBytes: 1024 * 1024,
			runtimeGid: identity.gid,
			runtimeUid: identity.uid,
			timeoutMs: COMPILE_TIMEOUT_MS,
		},
	);
	// Byte-compilation is an optimization: upstream ships files that are not
	// valid for every interpreter, so only a failure to run is an error.
	if (compiled.error) throw new Error("Hermes byte-compilation did not run");
	await warmAnonymousDashboard(paths, runtimeUser, gatewayUnit);
	warmAnonymousEgressSidecar(paths, identity);
	writeRuntimePlatformFileAtomic(paths, hermesWarmMarker(paths), "warmed\n", { mode: 0o600 });
}

async function warmAnonymousDashboard(
	paths: RuntimePaths,
	runtimeUser: string,
	gatewayUnit: string,
): Promise<void> {
	const command = runtimeCommandPath("hermes", paths.userHome);
	if (!command) throw new Error("Hermes is not installed");
	const start = spawnSync(
		"systemd-run",
		[
			"--user",
			"-M",
			`${runtimeUser}@`,
			"--collect",
			`--unit=${ANONYMOUS_DASHBOARD_UNIT}`,
			`--property=WorkingDirectory=${paths.userHome}`,
			`--setenv=HOME=${paths.userHome}`,
			`--setenv=HERMES_HOME=${join(paths.userHome, ".hermes")}`,
			command,
			"dashboard",
			"--host",
			"127.0.0.1",
			"--port",
			"9119",
			"--no-open",
			"--skip-build",
		],
		{ stdio: "ignore", timeout: 30_000 },
	);
	let warmError: Error | null = null;
	let stopFailed = false;
	try {
		if (start.status !== 0) throw new Error("anonymous Hermes dashboard did not start");
		const deadline = Date.now() + 120_000;
		let healthy = false;
		while (Date.now() < deadline) {
			try {
				const response = await fetch("http://127.0.0.1:9119/", {
					signal: AbortSignal.timeout(2_000),
				});
				if (response.ok) {
					healthy = true;
					break;
				}
			} catch {
				// The official dashboard is still starting.
			}
			await sleep(1_000);
		}
		if (!healthy) throw new Error("anonymous Hermes dashboard did not become healthy");
	} catch (error) {
		warmError = error instanceof Error ? error : new Error("anonymous Hermes warm-up failed");
	} finally {
		// The transient unit owns its entire cgroup, including background helpers.
		// No anonymous auth snapshot or process may survive into tenant adoption.
		const stopped = spawnSync(
			"systemctl",
			["--user", "-M", `${runtimeUser}@`, "stop", ANONYMOUS_DASHBOARD_UNIT, gatewayUnit],
			{ stdio: "ignore", timeout: 60_000 },
		);
		stopFailed = start.status === 0 && stopped.status !== 0;
	}
	if (warmError) throw warmError;
	if (stopFailed) throw new Error("anonymous Hermes dashboard did not stop");
}
