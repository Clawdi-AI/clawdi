import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import HERMES_MANAGED_ENV_HELPER from "./hermes_managed_env.py" with { type: "text" };
import { hermesManagedPython } from "./hermes-python";
import { hostedProviderEnvironment } from "./hosted-provider-resolution";
import { managedChannelHasAccounts } from "./managed-channel-reconciliation";
import type { RuntimeManifest } from "./manifest-contract";
import { runtimeAppRoot } from "./manifest-install";
import { recordValue } from "./manifest-shared";
import { spawnRuntimeUserCommand } from "./runtime-user-command";
import { runtimeSecretValue } from "./secret-values";

const channelFields = {
	telegram: [
		"TELEGRAM_BOT_TOKEN",
		"TELEGRAM_ALLOW_ALL_USERS",
		"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
	],
	discord: ["DISCORD_BOT_TOKEN", "DISCORD_ALLOW_ALL_USERS"],
	whatsapp: [
		"WHATSAPP_ENABLED",
		"WHATSAPP_MODE",
		"WHATSAPP_ALLOWED_USERS",
		"WHATSAPP_ALLOW_ALL_USERS",
		"WHATSAPP_DM_POLICY",
		"WHATSAPP_GROUP_POLICY",
	],
} as const;
const resultSchema = z.object({
	changed: z.boolean(),
	conflicts: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
});

export { HERMES_MANAGED_ENV_HELPER };

export function hermesManagedProfileEnvironment(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): Record<string, string> {
	if (manifest.runtimes.hermes?.enabled !== true) return {};
	const desired = { ...hostedProviderEnvironment(manifest, "hermes").placeholderEnv };
	const channels = recordValue(manifest.projection?.channels);
	const settings = manifest.runtimes.hermes.run;
	for (const [channel, fields] of Object.entries(channelFields)) {
		if (!managedChannelHasAccounts(channels?.[channel])) continue;
		for (const key of fields) {
			const ref = settings?.secretEnv?.[key];
			const value = ref ? runtimeSecretValue(secretValues ?? {}, ref) : settings?.env?.[key];
			if (ref && !value) throw new Error(`Hermes managed profile field ${key} is unavailable`);
			if (value) desired[key] = value;
		}
	}
	return desired;
}

export function reconcileHermesManagedEnvironment(input: {
	home: string;
	workspaceRoot: string;
	desired: Record<string, string>;
}) {
	return runManagedEnvironmentHelper(input);
}

export function acknowledgeHermesManagedEnvironment(input: {
	home: string;
	workspaceRoot: string;
}) {
	return runManagedEnvironmentHelper({ ...input, desired: {}, acknowledge: true });
}

function runManagedEnvironmentHelper(input: {
	home: string;
	workspaceRoot: string;
	desired: Record<string, string>;
	acknowledge?: boolean;
}) {
	if (
		!Object.keys(input.desired).length &&
		!existsSync(join(input.home, ".clawdi", "runtime", "hermes-managed-env.json"))
	)
		return { changed: false, conflicts: [] };
	const appRoot = runtimeAppRoot("hermes", input.home);
	if (!appRoot) throw new Error("Hermes application path is unavailable");
	const result = spawnRuntimeUserCommand(
		hermesManagedPython(input.home),
		["-c", HERMES_MANAGED_ENV_HELPER, appRoot, ...(input.acknowledge ? ["--acknowledge"] : [])],
		input.home,
		input.workspaceRoot,
		{
			environmentOverrides: { HERMES_HOME: join(input.home, ".hermes") },
			input: JSON.stringify(input.desired),
			timeoutMs: 30_000,
			maxBufferBytes: 64 * 1024,
		},
	);
	if (result.status !== 0 || result.error)
		throw new Error("Hermes managed profile environment synchronization failed");
	try {
		return resultSchema.parse(JSON.parse(String(result.stdout)));
	} catch {
		throw new Error("Hermes managed profile environment synchronization returned invalid output");
	}
}
