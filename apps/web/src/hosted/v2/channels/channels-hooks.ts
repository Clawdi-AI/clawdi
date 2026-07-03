"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChannelEditApi } from "@/hosted/v2/channels/channel-edit-client";
import type { ChannelCreate } from "@/hosted/v2/channels/channel-types";
import { toastApiError, unwrap, useApi } from "@/lib/api";

/**
 * Typed data hooks for the native channels surface. All reads/writes go
 * through the generated cloud-api client (`useApi`) against
 * `/v1/channels/*`; mutations invalidate the affected queries and surface
 * recoverable errors as toasts.
 */

const keys = {
	list: ["channels"] as const,
	pool: ["channel-bot-pool"] as const,
	health: ["channel-health"] as const,
	channel: (id: string) => ["channel", id] as const,
	agentLinks: (id: string) => ["channel-agent-links", id] as const,
	bindings: (id: string) => ["channel-bindings", id] as const,
	activity: (id: string) => ["channel-activity", id] as const,
	whatsappCreds: (id: string) => ["whatsapp-tenant-creds", id] as const,
};

export function useChannels() {
	const api = useApi();
	return useQuery({
		queryKey: keys.list,
		queryFn: async () => unwrap(await api.GET("/v1/channels")),
	});
}

export function useBotPool() {
	const api = useApi();
	return useQuery({
		queryKey: keys.pool,
		queryFn: async () => unwrap(await api.GET("/v1/channels/bot-pool")),
	});
}

export function useChannelHealth() {
	const api = useApi();
	return useQuery({
		queryKey: keys.health,
		queryFn: async () => unwrap(await api.GET("/v1/channels/health")),
	});
}

export function useChannel(id: string) {
	const api = useApi();
	return useQuery({
		queryKey: keys.channel(id),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/{account_id}", {
					params: { path: { account_id: id } },
				}),
			),
		enabled: Boolean(id),
	});
}

export function useChannelAgentLinks(id: string) {
	const api = useApi();
	return useQuery({
		queryKey: keys.agentLinks(id),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/{account_id}/agent-links", {
					params: { path: { account_id: id } },
				}),
			),
		enabled: Boolean(id),
	});
}

export function useChannelBindings(id: string) {
	const api = useApi();
	return useQuery({
		queryKey: keys.bindings(id),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/{account_id}/bindings", {
					params: { path: { account_id: id } },
				}),
			),
		enabled: Boolean(id),
	});
}

export function useChannelActivity(id: string) {
	const api = useApi();
	return useQuery({
		queryKey: keys.activity(id),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/{account_id}/activity", {
					params: { path: { account_id: id }, query: { limit: 50 } },
				}),
			),
		enabled: Boolean(id),
	});
}

/** Connected agents available to link / pair. Shares the `environments` key. */
export function useEnvironments() {
	const api = useApi();
	return useQuery({
		queryKey: ["environments"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
	});
}

export function useCreateChannel() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (body: ChannelCreate) => unwrap(await api.POST("/v1/channels", { body })),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.list });
			qc.invalidateQueries({ queryKey: keys.pool });
			qc.invalidateQueries({ queryKey: keys.health });
		},
		onError: toastApiError("Couldn't connect channel"),
	});
}

export function useDeleteChannel() {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: string) =>
			unwrap(
				await api.DELETE("/v1/channels/{account_id}", {
					params: { path: { account_id: id } },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.list });
			qc.invalidateQueries({ queryKey: keys.pool });
			qc.invalidateQueries({ queryKey: keys.health });
			toast.success("Channel removed");
		},
		onError: toastApiError("Couldn't remove channel"),
	});
}

export function useLinkAgent(accountId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (agentId: string) =>
			unwrap(
				await api.POST("/v1/channels/{account_id}/agent-links", {
					params: { path: { account_id: accountId } },
					body: { agent_id: agentId },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.agentLinks(accountId) });
			qc.invalidateQueries({ queryKey: ["agent-channel-links"] });
			qc.invalidateQueries({ queryKey: keys.pool });
		},
		onError: toastApiError("Couldn't link agent"),
	});
}

export function useRotateAgentToken(accountId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (linkId: string) =>
			unwrap(
				await api.POST("/v1/channels/{account_id}/agent-links/{link_id}/token", {
					params: { path: { account_id: accountId, link_id: linkId } },
				}),
			),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: keys.agentLinks(accountId) });
			qc.invalidateQueries({ queryKey: ["agent-channel-links"] });
			// Always confirm — the new token is also revealed inline when present,
			// but the rotation must never be a silent no-op even without a token.
			toast.success("Token rotated", {
				description: data.agent_token
					? "Copy the new token below — the previous one is now invalid."
					: "The previous token is now invalid.",
			});
		},
		onError: toastApiError("Couldn't rotate token"),
	});
}

export function useCreatePairCode(accountId: string) {
	const api = useApi();
	return useMutation({
		mutationFn: async (vars: { agent_id?: string; agent_link_id?: string; ttl_seconds?: number }) =>
			unwrap(
				await api.POST("/v1/channels/{account_id}/pair-codes", {
					params: { path: { account_id: accountId } },
					body: { ttl_seconds: vars.ttl_seconds ?? 900, ...vars },
				}),
			),
		onError: toastApiError("Couldn't create pairing code"),
	});
}

/** An agent's linked channels (+account summary) — fixes the per-channel N+1. */
export function useAgentChannelLinks(agentId: string, enabled = true) {
	const editApi = useChannelEditApi();
	return useQuery({
		queryKey: ["agent-channel-links", agentId],
		queryFn: () => editApi.listAgentLinks(agentId),
		enabled: enabled && Boolean(agentId),
	});
}

export function useUnlinkAgentChannel(agentId: string) {
	const editApi = useChannelEditApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (vars: { accountId: string; linkId: string }) =>
			editApi.unlinkAgent(vars.accountId, vars.linkId),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["agent-channel-links", agentId] });
			qc.invalidateQueries({ queryKey: keys.agentLinks(vars.accountId) });
			qc.invalidateQueries({ queryKey: keys.list });
			qc.invalidateQueries({ queryKey: keys.pool });
			toast.success("Channel unlinked");
		},
		onError: toastApiError("Couldn't unlink channel"),
	});
}

/** Unlink keyed by channel account (for the channel-detail Agents tab). */
export function useUnlinkChannelAgent(accountId: string) {
	const editApi = useChannelEditApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (linkId: string) => editApi.unlinkAgent(accountId, linkId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.agentLinks(accountId) });
			qc.invalidateQueries({ queryKey: ["agent-channel-links"] });
			qc.invalidateQueries({ queryKey: keys.list });
			qc.invalidateQueries({ queryKey: keys.pool });
			toast.success("Agent unlinked");
		},
		onError: toastApiError("Couldn't unlink agent"),
	});
}

export function useSyncCommands(accountId: string) {
	const api = useApi();
	return useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/channels/{account_id}/commands/sync", {
					params: { path: { account_id: accountId } },
					body: {},
				}),
			),
		onError: toastApiError("Couldn't sync commands"),
	});
}

// ── WhatsApp device linking (Baileys tenant credentials) ─────────────────────
// WhatsApp connects with NO token; a device is linked by minting a per-agent
// tenant credential (the Baileys auth material). The live QR/pairing handshake
// runs in the agent runtime over the credential's websocket_url.

export function useWhatsappTenantCreds(accountId: string, enabled = true) {
	const api = useApi();
	return useQuery({
		queryKey: keys.whatsappCreds(accountId),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/whatsapp/{account_id}/tenant-creds", {
					params: { path: { account_id: accountId } },
				}),
			),
		enabled,
	});
}

export function useCreateWhatsappTenantCred(accountId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (vars: { agent_id?: string; agent_link_id?: string }) =>
			unwrap(
				await api.POST("/v1/channels/whatsapp/{account_id}/tenant-creds", {
					params: { path: { account_id: accountId } },
					// `device` defaults to 1 server-side but the generated client types
					// it required — send the primary device.
					body: { device: 1, ...vars },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.whatsappCreds(accountId) });
			toast.success("Device credential minted", {
				description: "Finish pairing from the agent runtime to link the number.",
			});
		},
		onError: toastApiError("Couldn't link WhatsApp device"),
	});
}

export function useRevokeWhatsappTenantCred(accountId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (credentialId: string) =>
			unwrap(
				await api.DELETE("/v1/channels/whatsapp/{account_id}/tenant-creds/{credential_id}", {
					params: { path: { account_id: accountId, credential_id: credentialId } },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: keys.whatsappCreds(accountId) });
			toast.success("WhatsApp device unlinked");
		},
		onError: toastApiError("Couldn't unlink device"),
	});
}
