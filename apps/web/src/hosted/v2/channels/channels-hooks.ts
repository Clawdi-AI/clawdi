"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { normalizeAgentChannelLinks } from "@/hosted/v2/channels/channel-edit-client.logic";
import { CHANNEL_HEALTH_REFETCH_INTERVAL_MS } from "@/hosted/v2/channels/channel-health-query";
import {
	invalidateCreatedChannelQueries,
	channelKeys as keys,
	removeDeletedChannelQueries,
} from "@/hosted/v2/channels/channel-query-cache";
import { agentChannelLinksQueryBehavior } from "@/hosted/v2/channels/channel-query-options.logic";
import type {
	ChannelCreate,
	ChannelCreated,
	WhatsAppOnboardingSession,
} from "@/hosted/v2/channels/channel-types";
import { type OpenApiClient, toastApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
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

export function useWhatsAppOnboardingReadiness(enabled: boolean) {
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/whatsapp/onboarding/readiness",
		{},
		{
			enabled,
			staleTime: 10_000,
			refetchOnWindowFocus: false,
		},
	);
}

export function useWhatsAppOnboardingActions() {
	const api = useApi();
	const qc = useQueryClient();

	const accept = useCallback(
		async (result: WhatsAppOnboardingSession): Promise<WhatsAppOnboardingSession> => {
			if (result.state === "connected" && result.channel_account_id) {
				await invalidateCreatedChannelQueries(qc, {
					id: result.channel_account_id,
					agent_id: null,
				});
			}
			return result;
		},
		[qc],
	);

	const start = useSensitiveAction(async (input: { requestId: string; name: string }) =>
		accept(
			unwrap(
				await api.POST("/v1/channels/whatsapp/onboarding/sessions", {
					body: { request_id: input.requestId, name: input.name },
				}),
			),
		),
	);
	const refresh = useCallback(
		async (sessionId: string) =>
			accept(
				unwrap(
					await api.GET("/v1/channels/whatsapp/onboarding/sessions/{session_id}", {
						params: { path: { session_id: sessionId } },
					}),
				),
			),
		[accept, api],
	);
	const pairingCode = useSensitiveAction(
		async (input: { sessionId: string; phoneNumber: string }) =>
			accept(
				unwrap(
					await api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/pairing-code", {
						params: { path: { session_id: input.sessionId } },
						body: { phone_number: input.phoneNumber },
					}),
				),
			),
	);
	const cancel = useSensitiveAction(async (sessionId: string) =>
		accept(
			unwrap(
				await api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel", {
					params: { path: { session_id: sessionId } },
				}),
			),
		),
	);
	const retry = useSensitiveAction(async (sessionId: string) =>
		accept(
			unwrap(
				await api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/retry", {
					params: { path: { session_id: sessionId } },
				}),
			),
		),
	);

	return { start, refresh, pairingCode, cancel, retry };
}

export function useChannelAgentLinks(id: string) {
	return useOpenApi().useQuery(
		"get",
		"/v1/channels/{account_id}/agent-links",
		{ params: { path: { account_id: id } } },
		{ enabled: Boolean(id) },
	);
}

function channelBindingsQueryOptionsWhen(api: OpenApiClient, id: string, enabled: boolean) {
	return api.queryOptions(
		"get",
		"/v1/channels/{account_id}/bindings",
		{ params: { path: { account_id: id } } },
		{
			enabled: enabled && Boolean(id),
			refetchInterval: enabled ? 3_000 : false,
			refetchIntervalInBackground: false,
		},
	);
}

export function useChannelBindings(id: string, enabled = true) {
	return useQuery(channelBindingsQueryOptionsWhen(useOpenApi(), id, enabled));
}

export function useDeleteChannelBinding(accountId: string, agentId: string) {
	const api = useOpenApi();
	const qc = useQueryClient();
	const agentLinksKey = agentChannelLinksQueryOptions(api, agentId).queryKey;
	return api.useMutation("delete", "/v1/channels/{account_id}/bindings/{binding_id}", {
		onSuccess: async (result) => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: agentLinksKey, exact: true }),
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
	const openApi = useOpenApi();
	const qc = useQueryClient();
	return useSensitiveAction(async (body: ChannelCreate) => {
		try {
			const result = unwrap(await api.POST("/v1/channels", { body }));
			await invalidateCreatedChannelQueries(
				qc,
				result,
				result.agent_id
					? agentChannelLinksQueryOptions(openApi, result.agent_id).queryKey
					: undefined,
			);
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
			toastApiError("Couldn't add Custom bot")(error);
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
			toast.success("Custom bot deleted");
		},
		onError: toastApiError("Couldn't delete Custom bot"),
	});
}

export function useCreatePairCode(
	accountId: string,
	{ agentId, toastOnError = true }: { agentId?: string; toastOnError?: boolean } = {},
) {
	const api = useApi();
	const openApi = useOpenApi();
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
			if (agentId) {
				qc.invalidateQueries({
					queryKey: agentChannelLinksQueryOptions(openApi, agentId).queryKey,
					exact: true,
				});
			}
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

export function agentChannelLinksQueryOptions(
	api: OpenApiClient,
	agentId: string,
	{ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {},
) {
	return api.queryOptions(
		"get",
		"/v1/channels/agent-links",
		{ params: { query: { agent_id: agentId } } },
		{
			...agentChannelLinksQueryBehavior(agentId, { enabled, poll }),
			select: normalizeAgentChannelLinks,
		},
	);
}

/** An Agent's linked channels and active binding counts in one generated query. */
export function useAgentChannelLinks(agentId: string, enabled = true, poll = false) {
	return useQuery(agentChannelLinksQueryOptions(useOpenApi(), agentId, { enabled, poll }));
}

export function useUnlinkAgentChannel(agentId: string) {
	const api = useOpenApi();
	const qc = useQueryClient();
	const agentLinksKey = agentChannelLinksQueryOptions(api, agentId).queryKey;
	return api.useMutation("delete", "/v1/channels/{account_id}/agent-links/{link_id}", {
		onSuccess: (_data, vars) => {
			const accountId = vars.params.path.account_id;
			qc.invalidateQueries({ queryKey: agentLinksKey, exact: true });
			qc.invalidateQueries({ queryKey: keys.agentLinks(accountId) });
			qc.invalidateQueries({ queryKey: keys.bindings(accountId) });
			qc.invalidateQueries({ queryKey: keys.activity(accountId) });
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
