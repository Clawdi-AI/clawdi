import { type ApiClientOptions, createReadTransport, readApiBaseUrl } from "./read-transport";

/** Path of Web's Chatwoot identity route (`apps/web/src/routes/api/chatwoot/identity.ts`). */
export const CHATWOOT_IDENTITY_PATH = "/api/chatwoot/identity";

/**
 * Chatwoot's identity-validation hash for the signed-in Clerk user, from the Web dashboard's
 * server, which keeps the HMAC secret. Clients without Web's session cookie send their token.
 */
export function createSupportChatClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const url = `${readApiBaseUrl(options.baseUrl)}${CHATWOOT_IDENTITY_PATH}`;
	return {
		getIdentifierHash: (signal?: AbortSignal) =>
			transport.read(async (init) => {
				const response = await transport.fetch(new Request(url, init));
				if (!response.ok) return { response };
				const body: unknown = await response.json();
				const hash =
					typeof body === "object" && body !== null && "identifierHash" in body
						? body.identifierHash
						: undefined;
				return { data: typeof hash === "string" && hash ? hash : undefined, response };
			}, signal),
	};
}

export type SupportChatClient = ReturnType<typeof createSupportChatClient>;
