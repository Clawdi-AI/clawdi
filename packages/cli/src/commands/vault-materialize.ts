import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import { getConfig } from "../lib/config";
import { updateVaultEnv, validateVaultMaterial } from "../lib/vault-env";

interface MaterializeOptions {
	out: string;
	vault?: string;
	project?: string;
	section?: string;
}

export async function vaultMaterialize(options: MaterializeOptions): Promise<void> {
	const apiUrl = normalizeCloudApiBaseUrl(getConfig().apiUrl);
	const api = new ApiClient();
	const result = await updateVaultEnv(options.out, async (binding) => {
		if (binding && binding.apiUrl !== apiUrl)
			throw new Error("API URL differs from the saved Vault binding.");
		const me = await api
			.GET("/v1/auth/me")
			.then(unwrap)
			.catch(() => {
				throw new Error(
					"Could not verify the current account; check authentication and connectivity.",
				);
			});
		if (binding && binding.userId !== me.id)
			throw new Error("Account differs from the saved Vault binding.");
		const vaultId = options.vault ?? binding?.vaultId;
		const projectId = options.project ?? binding?.projectId;
		const section = options.section ?? binding?.section ?? null;
		if (!vaultId || !projectId)
			throw new Error("First pull requires --vault <uuid> and --project <uuid>.");
		if (
			binding &&
			(binding.vaultId !== vaultId ||
				binding.projectId !== projectId ||
				binding.section !== section)
		) {
			throw new Error("Source differs from the saved Vault binding; choose a new target file.");
		}
		const material = validateVaultMaterial(
			await api
				.POST("/v1/vault/material", {
					body: { vault_id: vaultId, project_id: projectId, section },
				})
				.then(unwrap)
				.catch((error: unknown) => {
					// API and JSON decoding errors may retain response bodies: never print them.
					if (error instanceof ApiError && error.status === 409) {
						throw new Error(
							"Vault fields are not distinct environment names. Select --section or rename the conflicting fields.",
						);
					}
					throw new Error(
						"Vault pull failed; check source access, size and connectivity. No values were printed.",
					);
				}),
		);
		if (
			material.user_id !== me.id ||
			material.vault_id !== vaultId ||
			material.project_id !== projectId ||
			material.section !== section
		) {
			throw new Error("Vault response identity changed; nothing was written.");
		}
		return { apiUrl, material };
	});
	console.log(JSON.stringify({ status: "synced", ...result }));
}
