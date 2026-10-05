import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import {
	createOpenClawHostedContextForHome,
	resolveHostedOpenClawWorkspace,
} from "./hosted-openclaw-context";
import {
	activateHostedOpenClawSkill,
	OPENCLAW_INSTALLED_TREE_EXCLUDES,
} from "./hosted-openclaw-skill";
import { prepareHostedBundledSkill } from "./hosted-sourced-skill-archive";
import { installedTreeMatches, withPreparedHostedSkill } from "./managed-skill-delivery";
import { installReservedManagedSkill } from "./managed-skill-reservation";
import { runtimeCommandPath } from "./manifest-install";
import {
	discoverOpenClawManagedProviderAuthAgentDirs,
	ensureOpenClawProviderAuthCapability,
	openClawSupportsOwnerBrowserBootstrap,
	removeOpenClawManagedProviderAuthProfiles,
} from "./manifest-oauth";
import { applyOpenClawConfigMergePatch } from "./openclaw-provider-config";
import { warmOpenClawGatewayEnvironment } from "./openclaw-warm-gateway";
import type { RuntimePaths } from "./paths";
import { installAnonymousOpenClawGatewayService } from "./runtime-systemd-reconciliation";
import { runRuntimeUserCommand, withRuntimeUserFileAccess } from "./runtime-user-command";

/** Shared structural settings; tokens are generated per instance, never per tenant. */
export function anonymousOpenClawGatewayPatch(token: string | null): Record<string, unknown> {
	return {
		gateway: {
			mode: "local",
			port: 18789,
			bind: "lan",
			auth: { mode: "token", token },
			controlUi: { basePath: "/", dangerouslyAllowHostHeaderOriginFallback: false },
		},
		channels: {},
		plugins: { entries: {} },
	};
}

/** Install software using the same official installer and ownership transaction
 * as normal apply. The reservation contains only path, version and source digest. */
export function preinstallOpenClawBundledSkill(paths: RuntimePaths): void {
	const skill = prepareHostedBundledSkill("clawdi", 1);
	const workspaceRoot = resolveHostedOpenClawWorkspace(paths.userHome);
	const targetDir = join(workspaceRoot, "skills", skill.id);
	installReservedManagedSkill(
		{
			targetDir,
			id: skill.id,
			version: 1,
			digest: skill.identity.digest,
			manager: "hosted-manifest",
		},
		() =>
			withPreparedHostedSkill(skill, (sourceDir) =>
				withRuntimeUserFileAccess(() =>
					activateHostedOpenClawSkill({
						home: paths.userHome,
						workspaceRoot,
						sourceDir,
						targetDir,
					}),
				),
			),
		{
			verify: () =>
				installedTreeMatches(skill, targetDir, { exclude: OPENCLAW_INSTALLED_TREE_EXCLUDES }),
			discard: () => {
				throw new Error("anonymous bundled Skill installation could not be verified");
			},
		},
	);
}

/** The sealed volume carries a disabled official unit, no usable gateway token
 * and no process. The /run environment-file condition also gates copied units. */
export function prepareAnonymousOpenClawGateway(
	paths: RuntimePaths,
	identity: { uid: number; gid: number },
): void {
	const command = runtimeCommandPath("openclaw", paths.userHome);
	const sdk =
		command &&
		resolveOpenClawSdkExport(paths.userHome, [command], OPENCLAW_SDK_EXPORT_PATHS.configMutation);
	if (!sdk) throw new Error("OpenClaw config-mutation SDK export is unavailable");
	const manager = spawnSync("systemctl", ["start", `user@${identity.uid}.service`], {
		stdio: "ignore",
		timeout: 60_000,
	});
	if (manager.error || manager.status !== 0)
		throw new Error("anonymous runtime user manager did not start");
	applyOpenClawConfigMergePatch(
		sdk,
		JSON.stringify(anonymousOpenClawGatewayPatch(randomBytes(32).toString("base64url"))),
		paths.userHome,
		paths.userHome,
	);
	const unit = installAnonymousOpenClawGatewayService(
		paths,
		identity,
		warmOpenClawGatewayEnvironment(paths),
	);
	runRuntimeUserCommand(
		"systemctl",
		["--user", "disable", "--now", unit],
		"",
		paths.userHome,
		paths.userHome,
		{
			runtimeUid: identity.uid,
			runtimeGid: identity.gid,
			timeoutMs: 120_000,
		},
	);
	// Neither a copied token nor a credential env key is an activation authority.
	applyOpenClawConfigMergePatch(
		sdk,
		JSON.stringify(anonymousOpenClawGatewayPatch(null)),
		paths.userHome,
		paths.userHome,
	);
	preinstallOpenClawBundledSkill(paths);
}

/** Version-bound capability answers and empty anonymous auth-store discovery. */
export function seedAnonymousOpenClawAuthProbes(paths: RuntimePaths, command: string): void {
	const revision = "anonymous-preinstallation";
	const context = createOpenClawHostedContextForHome(paths.userHome, true);
	context.refreshSdkExports({ commandPath: command });
	openClawSupportsOwnerBrowserBootstrap(context, revision);
	ensureOpenClawProviderAuthCapability({
		context,
		revision,
		oauth: false,
		cleanupManagedProvider: true,
	});
	context.agentDirs.managed = discoverOpenClawManagedProviderAuthAgentDirs(context, revision);
	removeOpenClawManagedProviderAuthProfiles(context, paths.userHome, revision);
}
