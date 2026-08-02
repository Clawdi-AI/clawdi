"use client";

import {
	queryOptions,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useChannelEditApi } from "@/hosted/v2/channels/channel-edit-client";
import { channelHealthQueryOptions } from "@/hosted/v2/channels/channel-health-query";
import {
	invalidateCreatedChannelQueries,
	channelKeys as keys,
	removeDeletedChannelQueries,
} from "@/hosted/v2/channels/channel-query-cache";
import type { ChannelCreate, ChannelCreated } from "@/hosted/v2/channels/channel-types";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/**
 * Typed data hooks for the native channels surface. All reads/writes go
 * through the generated cloud-api client (`useApi`) against
 * `/v1/channels/*`; mutations invalidate the affected queries and surface
 * recoverable errors as toasts.
 */

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
	return useQuery(
		channelHealthQueryOptions(async () => unwrap(await api.GET("/v1/channels/health"))),
	);
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

function channelBindingsQueryOptions(api: ReturnType<typeof useApi>, id: string) {
	return queryOptions({
		queryKey: keys.bindings(id),
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/channels/{account_id}/bindings", {
					params: { path: { account_id: id } },
				}),
			),
		enabled: Boolean(id),
		refetchInterval: 3_000,
	});
}

export function useChannelBindings(id: string) {
	return useQuery(channelBindingsQueryOptions(useApi(), id));
}

export function useChannelBindingsForAccounts(accountIds: readonly string[]) {
	const api = useApi();
	return useQueries({
		queries: accountIds.map((accountId) => channelBindingsQueryOptions(api, accountId)),
	});
}

export function useDeleteChannelBinding(accountId: string) {
	const api = useApi();
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (bindingId: string) =>
			unwrap(
				await api.DELETE("/v1/channels/{account_id}/bindings/{binding_id}", {
					params: { path: { account_id: accountId, binding_id: bindingId } },
				}),
			),
		onSuccess: async (result) => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: keys.bindings(accountId) }),
				qc.invalidateQueries({ queryKey: keys.activity(accountId) }),
			]);
			if (result.warning) {
				toast.warning("Chat unpaired", { description: result.warning });
			} else if (result.unpaired) {
				toast.success("Chat unpaired");
			}
		},
		onError: toastApiError("Couldn't unpair chat"),
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
		queryKey: ["agents"],
		queryFn: async () => unwrap(await api.GET("/v1/agents")),
	});
}

export function useCreateChannel() {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(async (body: ChannelCreate) => {
		try {
			const result = unwrap(await api.POST("/v1/channels", { body }));
			await invalidateCreatedChannelQueries(qc, result);
			return {
				id: result.id,
				name: result.name,
				provider: result.provider,
				webhook_url: result.webhook_url,
				agent_link_id: result.agent_link_id ?? null,
				agent_id: result.agent_id ?? null,
			} satisfies Pick<
				ChannelCreated,
				"id" | "name" | "provider" | "webhook_url" | "agent_link_id" | "agent_id"
			>;
		} catch (error) {
			toastApiError("Couldn't connect Custom bot")(error);
			throw error;
		}
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
		onSuccess: async (_data, id) => {
			await removeDeletedChannelQueries(qc, id);
			toast.success("Channel removed");
		},
		onError: toastApiError("Couldn't remove channel"),
	});
}

export function useCreatePairCode(
	accountId: string,
	{ toastOnError = true }: { toastOnError?: boolean } = {},
) {
	const api = useApi();
	const qc = useQueryClient();
	return useSensitiveAction(async (vars: { agent_link_id: string; ttl_seconds?: number }) => {
		try {
			const result = unwrap(
				await api.POST("/v1/channels/{account_id}/pair-codes", {
					params: { path: { account_id: accountId } },
					body: { ttl_seconds: vars.ttl_seconds ?? 300, ...vars },
				}),
			);
			qc.invalidateQueries({ queryKey: keys.agentLinks(accountId) });
			qc.invalidateQueries({ queryKey: ["agent-channel-links"] });
			qc.invalidateQueries({ queryKey: keys.bindings(accountId) });
			return {
				code: result.code,
				expires_at: result.expires_at,
				agent_link_id: result.agent_link_id,
				pairing_command: result.pairing_command,
				bot_username: result.bot_username,
				deep_link: result.deep_link,
				qr_payload: result.qr_payload,
				discord_install_url: result.discord_install_url,
				discord_user_install_url: result.discord_user_install_url,
			};
		} catch (error) {
			if (toastOnError) toastApiError("Couldn't create pairing code")(error);
			throw error;
		}
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
