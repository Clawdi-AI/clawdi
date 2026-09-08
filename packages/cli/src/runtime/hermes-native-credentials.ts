import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import HERMES_NATIVE_CREDENTIALS_HELPER from "./hermes_native_credentials.py" with { type: "text" };
import { runtimeAppRoot } from "./manifest-install";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,119}$/);
const resultSchema = z.object({
	changed: z.boolean(),
	selectedProvider: providerId.nullable(),
	strategyUpdates: z.record(
		providerId,
		z.object({ exists: z.boolean(), value: z.unknown().optional() }),
	),
});

export interface HermesNativeCredentialsInput {
	home: string;
	workspaceRoot: string;
	providers: ReadonlyArray<{ providerId: string; apiKey: string; baseUrl: string }>;
	previousProviderIds: readonly string[];
	strategies: Readonly<Record<string, unknown>>;
	selectedProvider?: string;
}

// The text loader embeds this resource in both Node and native CLI bundles.
export { HERMES_NATIVE_CREDENTIALS_HELPER };

export function reconcileHermesNativeCredentials(input: HermesNativeCredentialsInput) {
	if (
		input.providers.length === 0 &&
		input.previousProviderIds.length === 0 &&
		!existsSync(join(input.home, ".clawdi", "runtime", "hermes-native-credentials.json"))
	) {
		return {
			changed: false,
			strategyUpdates: {},
			selectedProvider: input.selectedProvider ?? null,
		};
	}
	const appRoot = runtimeAppRoot("hermes", input.home);
	if (!appRoot) throw new Error("Hermes application path is unavailable");
	const result = spawnRuntimeUserCommand(
		join(appRoot, "venv", "bin", "python"),
		["-c", HERMES_NATIVE_CREDENTIALS_HELPER, appRoot],
		input.home,
		input.workspaceRoot,
		{
			environmentOverrides: { HERMES_HOME: join(input.home, ".hermes") },
			input: JSON.stringify({
				providers: input.providers,
				previousProviderIds: input.previousProviderIds,
				strategies: input.strategies,
				selectedProvider: input.selectedProvider,
			}),
			timeoutMs: 30_000,
			maxBufferBytes: 64 * 1024,
		},
	);
	if (result.status !== 0) throw new Error("Hermes native credential synchronization failed");
	try {
		return resultSchema.parse(JSON.parse(String(result.stdout)));
	} catch {
		throw new Error("Hermes native credential synchronization returned invalid output");
	}
}
