import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";
import { type WhatsAppSession, whatsappPhoneNumberError } from "./whatsapp-onboarding";

/** Sensitive sessions never belong in query caches. Starts use a caller-retained UUID. */
export function createWhatsAppClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	const path = (id: string) => ({ session_id: readResourceId(id) });
	const check = (session: WhatsAppSession, id?: string) => {
		if (
			!session ||
			typeof session.id !== "string" ||
			!session.id ||
			(id && session.id !== id) ||
			!["generating", "ready", "scanned", "connected", "expired", "canceled", "error"].includes(
				session.state,
			) ||
			!Number.isFinite(Date.parse(session.expires_at))
		)
			throw new ApiClientResponseError();
		return session;
	};
	return {
		readiness: (signal?: AbortSignal) =>
			transport.read((init) => api.GET("/v1/channels/whatsapp/onboarding/readiness", init), signal),
		start: async (requestId: string, name: string, signal?: AbortSignal) => {
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
				!name.trim() ||
				name.length > 120
			)
				throw new ApiClientError(400, "invalid_onboarding_request");
			return check(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/whatsapp/onboarding/sessions", {
							...init,
							body: { request_id: requestId, name },
						}),
					signal,
				),
			);
		},
		get: async (id: string, signal?: AbortSignal) =>
			check(
				await transport.read(
					(init) =>
						api.GET("/v1/channels/whatsapp/onboarding/sessions/{session_id}", {
							...init,
							params: { path: path(id) },
						}),
					signal,
				),
				id,
			),
		pairingCode: async (id: string, phone: string, signal?: AbortSignal) => {
			if (!phone || whatsappPhoneNumberError(phone))
				throw new ApiClientError(400, "invalid_phone_number");
			return check(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/pairing-code", {
							...init,
							params: { path: path(id) },
							body: { phone_number: phone },
						}),
					signal,
				),
				id,
			);
		},
		cancel: async (id: string, signal?: AbortSignal) =>
			check(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/cancel", {
							...init,
							params: { path: path(id) },
						}),
					signal,
				),
				id,
			),
		retry: async (id: string, signal?: AbortSignal) =>
			check(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/whatsapp/onboarding/sessions/{session_id}/retry", {
							...init,
							params: { path: path(id) },
						}),
					signal,
				),
				id,
			),
		repair: async (accountId: string, signal?: AbortSignal) => {
			const result = check(
				await transport.read(
					(init) =>
						api.POST("/v1/channels/whatsapp/onboarding/accounts/{account_id}/repair", {
							...init,
							params: { path: { account_id: readResourceId(accountId) } },
						}),
					signal,
				),
			);
			if (result.channel_account_id !== accountId) throw new ApiClientResponseError();
			return result;
		},
	};
}
export type WhatsAppClient = ReturnType<typeof createWhatsAppClient>;
