"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChannelEditApi } from "@/hosted/v2/channels/channel-edit-client";
import { CHANNEL_HEALTH_REFETCH_INTERVAL_MS } from "@/hosted/v2/channels/channel-health-query";
import {
	invalidateCreatedChannelQueries,
	channelKeys as keys,
	removeDeletedChannelQueries,
} from "@/hosted/v2/channels/channel-query-cache";
import type { ChannelCreate, ChannelCreated } from "@/hosted/v2/channels/channel-types";
import { toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/**
 * Typed data hooks for the native channels surface. All reads/writes go
 * through the generated cloud-api client (`useOpenApi` or `useApi`) against
 * `/v1/channels/*`; mutations invalidate the affected queries and surface
 * recoverable errors as toasts.
 */

export function useChannels() {
	return useOpenApi().useQuery("get", "/v1/channels");
}

export function useBotPool() {
	return useOpenApi().useQuery("get", "/v1/channels/bot-pool");
}

export function useChannelHealth() {
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/health",
		{},
		{
			refetchInterval: CHANNEL_HEALTH_REFETCH_INTERVAL_MS,
			refetchIntervalInBackground: false,
		},
	);
}

export function useChannel(id: string) {
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/{account_id}",
		{ params: { path: { account_id: id } } },
		{ enabled: Boolean(id) },
	);
}

export function useChannelAgentLinks(id: string) {
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/{account_id}/agent-links",
		{ params: { path: { account_id: id } } },
		{ enabled: Boolean(id) },
	);
}

function channelBindingsQueryOptions(api: ReturnType<typeof useOpenApi>, id: string) {
	return api.queryOptions(
		"get",
		"/v1/channels/{account_id}/bindings",
		{ params: { path: { account_id: id } } },
		{ enabled: Boolean(id), refetchInterval: 3_000, refetchIntervalInBackground: false },
	);
}

export function useChannelBindings(id: string) {
	return useQuery(channelBindingsQueryOptions(useOpenApi(), id));
}

export function useChannelBindingsForAccounts(accountIds: readonly string[]) {
	const api = useOpenApi();
	return useQueries({
		queries: accountIds.map((accountId) => channelBindingsQueryOptions(api, accountId)),
	});
}

export function useDeleteChannelBinding(accountId: string) {
	const api = useOpenApi();
	const qc = useQueryClient();
	return api.useMutation("delete", "/v1/channels/{account_id}/bindings/{binding_id}", {
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
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/{account_id}/activity",
		{ params: { path: { account_id: id }, query: { limit: 50 } } },
		{ enabled: Boolean(id) },
	);
}

/** Connected agents available to link / pair. Shares the `environments` key. */
export function useEnvironments() {
	return useOpenApi().useQuery("get", "/v1/agents", {});
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
	const api = useOpenApi();
	const qc = useQueryClient();
	return api.useMutation("delete", "/v1/channels/{account_id}", {
		onSuccess: async (_data, variables) => {
			const id = variables.params.path.account_id;
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
