export type AiProviderBindingAuthKind = "managed" | "api_key" | "codex_oauth";

export interface AiProviderBindingSecretReference {
	store: "external";
	name: string;
	version?: string;
}

export interface AiProviderBinding {
	provider_id: string;
	auth_kind: AiProviderBindingAuthKind;
	secret_reference?: AiProviderBindingSecretReference;
}

export interface AiProviderPrimaryModelReference {
	provider_id: string;
	model: string;
}

/** Normalize the ordered provider identities used by the full binding boundary. */
export function normalizeAiProviderBindingProviderIds(
	providerIds: readonly string[],
	primaryProviderId: string,
): string[] {
	const normalized = providerIds.map(normalizeProviderId);
	if (normalized.length === 0) throw new Error("AI provider binding pool cannot be empty.");
	if (normalized.length > 20) {
		throw new Error("AI provider binding pool cannot contain more than 20 providers.");
	}
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("AI provider binding pool cannot contain duplicate provider_id values.");
	}
	const primary = normalizeProviderId(primaryProviderId);
	if (!normalized.includes(primary)) {
		throw new Error("primary_model.provider_id must belong to the AI provider binding pool.");
	}
	return normalized;
}

/** Canonical ordered provider-pool boundary shared by serializers and runtimes. */
export function normalizeAiProviderBindingPool(input: {
	bindings: readonly AiProviderBinding[];
	primaryModel: AiProviderPrimaryModelReference;
}): AiProviderBinding[] {
	const normalized = input.bindings.map((binding) => {
		const providerId = normalizeProviderId(binding.provider_id);
		const secretName = binding.secret_reference?.name.trim();
		const secretVersion = binding.secret_reference?.version?.trim();
		if (binding.auth_kind === "managed" && binding.secret_reference) {
			throw new Error(`Managed AI provider binding ${providerId} cannot carry a secret_reference.`);
		}
		if (
			binding.auth_kind !== "managed" &&
			(binding.secret_reference?.store !== "external" || secretName !== providerId)
		) {
			throw new Error(
				`External AI provider binding ${providerId} requires a matching external secret_reference.`,
			);
		}
		if (binding.secret_reference?.version !== undefined && !secretVersion) {
			throw new Error(`AI provider binding ${providerId} has an empty secret version.`);
		}
		if (secretVersion && secretVersion.length > 128) {
			throw new Error(`AI provider binding ${providerId} secret version exceeds 128 characters.`);
		}
		return {
			provider_id: providerId,
			auth_kind: binding.auth_kind,
			...(binding.secret_reference && secretName
				? {
						secret_reference: {
							store: "external" as const,
							name: secretName,
							...(secretVersion ? { version: secretVersion } : {}),
						},
					}
				: {}),
		};
	});
	normalizeAiProviderBindingProviderIds(
		normalized.map((binding) => binding.provider_id),
		input.primaryModel.provider_id,
	);
	if (normalized.filter((binding) => binding.auth_kind === "codex_oauth").length > 1) {
		throw new Error("AI provider binding pool cannot contain more than one OAuth family.");
	}
	return normalized;
}

function normalizeProviderId(value: string): string {
	const providerId = value.trim();
	if (!providerId || providerId.length > 80) {
		throw new Error("AI provider binding has an invalid provider_id.");
	}
	return providerId;
}
