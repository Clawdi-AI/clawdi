import createClient from "openapi-fetch";
import type { DeployPaths } from "./deploy";
import {
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

/** Explicit credential issuance only. Never persist/log the URL or automatically retry. */
export function createTerminalClient(options: ApiClientOptions) {
	const baseUrl = readApiBaseUrl(options.baseUrl, true);
	const base = new URL(baseUrl);
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({ baseUrl, fetch: transport.fetch });
	return {
		createSession: async (deploymentId: string, signal?: AbortSignal) => {
			const id = readResourceId(deploymentId);
			const session = await transport.read(
				(init) =>
					api.POST("/v2/deployments/{deployment_id}/terminal", {
						...init,
						params: { path: { deployment_id: id } },
					}),
				signal,
			);
			if (
				!session ||
				session.deployment_id !== id ||
				typeof session.websocket_url !== "string" ||
				typeof session.expires_at !== "string" ||
				!Number.isFinite(Date.parse(session.expires_at)) ||
				Date.parse(session.expires_at) <= Date.now()
			)
				throw new ApiClientResponseError();
			let target: URL;
			try {
				target = new URL(session.websocket_url);
			} catch {
				throw new ApiClientResponseError();
			}
			const fragment = new URLSearchParams(target.hash.slice(1));
			const tokens = [...target.searchParams.getAll("token"), ...fragment.getAll("token")];
			if (
				target.protocol !== (base.protocol === "https:" ? "wss:" : "ws:") ||
				target.host !== base.host ||
				target.username ||
				target.password ||
				target.pathname !==
					`${base.pathname.replace(/\/$/, "")}/v2/deployments/${encodeURIComponent(id)}/terminal/ws` ||
				[...target.searchParams.keys(), ...fragment.keys()].some((key) => key !== "token") ||
				tokens.length !== 1 ||
				!/^[A-Za-z0-9._~-]{1,8192}$/.test(tokens[0] ?? "")
			)
				throw new ApiClientResponseError();
			return session;
		},
	};
}
export type TerminalClient = ReturnType<typeof createTerminalClient>;
