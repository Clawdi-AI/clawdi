import type { components } from "@/lib/api-schemas";

type WhatsAppTenantCredentialMetadata = components["schemas"]["WhatsAppTenantCredentialMetadata"];

/** Allowlist the non-secret device metadata that the linked-devices UI caches. */
export function whatsappCredentialMetadataForCache(
	credentials: readonly WhatsAppTenantCredentialMetadata[],
): WhatsAppTenantCredentialMetadata[] {
	return credentials.map((credential) => ({
		credential_id: credential.credential_id,
		agent_link_id: credential.agent_link_id,
		agent_id: credential.agent_id,
		jid: credential.jid,
		identity_pub_key_hex: credential.identity_pub_key_hex,
		created_at: credential.created_at,
	}));
}
