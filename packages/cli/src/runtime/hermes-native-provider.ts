import {
	getHermesRawConfigValue,
	type HermesConfigTransaction,
	reconcileHermesConfigValue,
} from "./hermes-config";
import { reconcileHermesNativeCredentials } from "./hermes-native-credentials";
import type { NativeProviderConnection } from "./hosted-provider-resolution";
import { isPlainRecord, stringValue } from "./manifest-shared";
import { runtimeSecretValue } from "./secret-values";

export function applyHermesNativeProviders(input: {
	connections: readonly NativeProviderConnection[];
	previousProviderIds: readonly string[];
	secretValues: Record<string, string>;
	config: HermesConfigTransaction;
	home: string;
	workspaceRoot: string;
}) {
	const { connections, config } = input;
	const providers = connections.flatMap((connection) => {
		if (connection.auth.kind !== "api-key") return [];
		const apiKey = runtimeSecretValue(input.secretValues, connection.auth.secretRef);
		if (!apiKey) throw new Error("Native Hermes provider credential is unavailable");
		return [
			{
				providerId: connection.routing.hermes.provider,
				apiKey,
				baseUrl: connection.routing.base_url,
			},
		];
	});
	const current = getHermesRawConfigValue(config, "credential_pool_strategies");
	if (current.exists && !isPlainRecord(current.value))
		throw new Error("Hermes credential strategies must be an object");
	const strategies = isPlainRecord(current.value) ? current.value : {};
	const selected = getHermesRawConfigValue(config, "model.provider");
	const auth = reconcileHermesNativeCredentials({
		home: input.home,
		workspaceRoot: input.workspaceRoot,
		providers,
		previousProviderIds: input.previousProviderIds,
		strategies,
		selectedProvider: stringValue(selected.value)?.trim().toLowerCase(),
	});
	let changed = auth.changed;
	if (
		connections.some((connection) => connection.routing.hermes.provider === auth.selectedProvider)
	) {
		for (const field of ["base_url", "api_key", "api", "key_env", "api_mode", "auth_mode"]) {
			const path = `model.${field}`;
			if (getHermesRawConfigValue(config, path).exists) {
				reconcileHermesConfigValue(config, path, undefined);
				changed = true;
			}
		}
	}
	if (Object.keys(auth.strategyUpdates).length > 0) {
		const next = { ...strategies };
		for (const [id, value] of Object.entries(auth.strategyUpdates)) {
			if (value.exists) next[id] = value.value;
			else delete next[id];
		}
		reconcileHermesConfigValue(
			config,
			"credential_pool_strategies",
			Object.keys(next).length > 0 ? next : undefined,
		);
	}
	return { changed, providerIds: providers.map((provider) => provider.providerId) };
}
