import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { hermesManagedPython } from "./hermes-python";
import type { RuntimePaths } from "./paths";
import { installAnonymousHermesGatewayService } from "./runtime-systemd-reconciliation";
import { runtimeUserGid, runtimeUserUid, spawnRuntimeUserCommand } from "./runtime-user-command";

const COMPILE_TIMEOUT_MS = 600_000;

/**
 * Pool warm-up for a booted, unclaimed Hermes instance. Only tenant-independent
 * work runs: the official gateway unit is installed exactly as tenant convergence
 * would install it, and the Hermes application tree is byte-compiled so the first
 * gateway and dashboard start after a claim does not compile. No manifest,
 * credential or tenant identity is read and no Hermes service is started.
 */
export function warmHostedHermesRuntime(paths: RuntimePaths, runtimeUser = "clawdi"): void {
	if (paths.mode !== "hosted") throw new Error("runtime warm requires hosted runtime mode");
	const identity = { uid: runtimeUserUid(runtimeUser), gid: runtimeUserGid(runtimeUser) };
	const manager = spawnSync("systemctl", ["start", `user@${identity.uid}.service`], {
		stdio: "ignore",
		timeout: 60_000,
	});
	if (manager.status !== 0) throw new Error("runtime user manager did not start");
	installAnonymousHermesGatewayService(paths, identity);
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
}
