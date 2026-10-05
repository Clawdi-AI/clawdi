import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { runtimeCommandPath } from "./manifest-install";
import { applyOpenClawConfigMergePatch } from "./openclaw-provider-config";
import type { RuntimePaths } from "./paths";
import { installAnonymousOpenClawGatewayService } from "./runtime-systemd-reconciliation";
import { runtimeUserGid, runtimeUserUid } from "./runtime-user-command";

/**
 * Pool warm-up for a booted instance that has not been claimed: start the
 * OpenClaw gateway with the structural settings every hosted tenant uses
 * (local mode, port 18789, LAN bind, token auth, root Control UI path) and a
 * random instance-local token. No manifest, credential or tenant identity is
 * read; tenant convergence later replaces the token and adds tenant config by
 * the gateway's hot reload. Experimental and unused unless explicitly invoked.
 */
export function warmHostedOpenClawRuntime(paths: RuntimePaths, runtimeUser = "clawdi"): void {
	if (paths.mode !== "hosted") throw new Error("runtime warm requires hosted runtime mode");
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
	const patch = {
		gateway: {
			mode: "local",
			port: 18789,
			bind: "lan",
			auth: { mode: "token", token: randomBytes(32).toString("base64url") },
			controlUi: { basePath: "/", dangerouslyAllowHostHeaderOriginFallback: false },
		},
	};
	applyOpenClawConfigMergePatch(sdk, JSON.stringify(patch), paths.userHome, paths.userHome);
	const unit = installAnonymousOpenClawGatewayService(paths, identity);
	const start = spawnSync("systemctl", ["--user", "-M", `${runtimeUser}@`, "start", unit], {
		stdio: "ignore",
		timeout: 120_000,
	});
	if (start.status !== 0) throw new Error("anonymous OpenClaw gateway did not start");
}
