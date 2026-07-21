import type { Page, Route } from "@playwright/test";

export const CLOUD_API = "http://127.0.0.1:8000";
export const DEPLOY_API = process.env.E2E_HOSTED_DEPLOY_API_URL ?? "http://127.0.0.1:50001";

export const CLOUD_AGENT_ID = "agent_e2e_codex";
export const CLOUD_CHANNEL_ID = "chan_e2e_telegram";

const emptyPage = { items: [], total: 0, page: 1, page_size: 25 };

type JsonRecord = Record<string, unknown>;

export async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function requestJson(route: Route): JsonRecord {
	try {
		return (route.request().postDataJSON() ?? {}) as JsonRecord;
	} catch {
		return {};
	}
}

function cloudAgent(): JsonRecord {
	return {
		id: CLOUD_AGENT_ID,
		machine_name: "e2e-codex",
		display_name: "E2E Codex",
		default_name: "Codex",
		agent_type: "codex",
		status: "online",
		avatar_url: null,
		source: "hosted",
		last_seen_at: "2026-07-11T12:00:00Z",
	};
}

function initialChannel(): JsonRecord {
	return {
		id: CLOUD_CHANNEL_ID,
		provider: "telegram",
		name: "E2E Telegram",
		status: "active",
		visibility: "private",
		created_at: "2026-07-11T12:00:00Z",
		updated_at: "2026-07-11T12:00:00Z",
		config: {},
	};
}

function managedProvider(): JsonRecord {
	return {
		provider_id: "clawdi-managed-v2",
		type: "openai",
		label: "Clawdi managed",
		base_url: "https://api.openai.com/v1",
		api_mode: "openai_chat",
		auth: { type: "managed" },
		managed_by: "clawdi",
		runtime_env_name: null,
		models: [{ id: "openai/gpt-4o-mini", label: "GPT-4o mini" }],
	};
}

export async function stubCloudApi(page: Page) {
	const channels: JsonRecord[] = [initialChannel()];
	const linksByChannel = new Map<string, JsonRecord[]>([
		[
			CLOUD_CHANNEL_ID,
			[
				{
					id: "link_e2e_telegram_codex",
					account_id: CLOUD_CHANNEL_ID,
					agent_id: CLOUD_AGENT_ID,
					status: "active",
					agent_token: "clawdi_link_token",
					created_at: "2026-07-11T12:00:00Z",
				},
			],
		],
	]);
	const providers: JsonRecord[] = [managedProvider()];

	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
	await page.route(`${DEPLOY_API}/me`, (route) =>
		fulfillJson(route, {
			capabilities: { can_use_v1: false, can_use_v2: true, can_use_plan_c_billing: true },
		}),
	);
	await page.route(`${DEPLOY_API}/v1/me`, (route) =>
		fulfillJson(route, {
			capabilities: { can_use_v1: false, can_use_v2: true, can_use_plan_c_billing: true },
		}),
	);

	await page.route(`${CLOUD_API}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();

		if (path === "/v1/agents") return fulfillJson(route, [cloudAgent()]);
		if (path === `/v1/agents/${CLOUD_AGENT_ID}`) return fulfillJson(route, cloudAgent());
		if (path === "/v1/projects") return fulfillJson(route, []);
		if (path === "/v1/projects/default") return fulfillJson(route, { project_id: "proj_e2e" });
		if (path === "/v1/sessions") return fulfillJson(route, emptyPage);
		if (path === "/v1/auth/keys") return fulfillJson(route, []);
		if (path === "/v1/hosted/agent-ownership") {
			return fulfillJson(route, { items: [], legacy_env_ids: [] });
		}
		if (path === "/v1/dashboard/stats") {
			return fulfillJson(route, {
				total_sessions: 0,
				total_projects: 0,
				total_vaults: 0,
				current_streak: 0,
				contribution: [],
			});
		}

		if (path === "/v1/channels" && method === "GET") return fulfillJson(route, channels);
		if (path === "/v1/channels" && method === "POST") {
			const body = requestJson(route);
			const created = {
				id: `chan_e2e_${channels.length + 1}`,
				provider: body.provider ?? "telegram",
				name: body.name ?? "E2E Channel",
				status: "active",
				visibility: "private",
				created_at: "2026-07-11T12:00:00Z",
				updated_at: "2026-07-11T12:00:00Z",
				config: body.config ?? {},
				agent_token: null,
			};
			channels.push(created);
			linksByChannel.set(created.id, []);
			return fulfillJson(route, created);
		}
		if (path === "/v1/channels/bot-pool") return fulfillJson(route, { providers: {} });
		if (path === "/v1/channels/health") {
			return fulfillJson(route, {
				items: channels.map((channel) => ({
					account_id: channel.id,
					health_status: "ok",
					failed_deliveries: 0,
					last_delivery_at: "2026-07-11T12:00:00Z",
				})),
			});
		}
		const channelMatch = path.match(/^\/v1\/channels\/([^/]+)$/);
		if (channelMatch && method === "GET") {
			const channel = channels.find((item) => item.id === channelMatch[1]);
			return fulfillJson(route, channel ?? { detail: "not found" }, channel ? 200 : 404);
		}
		if (channelMatch && method === "DELETE") {
			const index = channels.findIndex((item) => item.id === channelMatch[1]);
			if (index >= 0) channels.splice(index, 1);
			linksByChannel.delete(channelMatch[1]);
			return fulfillJson(route, { status: "deleted" });
		}
		const channelLinksMatch = path.match(/^\/v1\/channels\/([^/]+)\/agent-links$/);
		if (channelLinksMatch && method === "GET") {
			return fulfillJson(route, linksByChannel.get(channelLinksMatch[1]) ?? []);
		}
		if (channelLinksMatch && method === "POST") {
			const body = requestJson(route);
			const link = {
				id: `link_e2e_${Date.now()}`,
				account_id: channelLinksMatch[1],
				agent_id: body.agent_id ?? CLOUD_AGENT_ID,
				status: "active",
				agent_token: "clawdi_new_link_token",
				created_at: "2026-07-11T12:00:00Z",
			};
			const links = linksByChannel.get(channelLinksMatch[1]) ?? [];
			links.push(link);
			linksByChannel.set(channelLinksMatch[1], links);
			return fulfillJson(route, link);
		}
		const unlinkMatch = path.match(/^\/v1\/channels\/([^/]+)\/agent-links\/([^/]+)$/);
		if (unlinkMatch && method === "DELETE") {
			const links = linksByChannel.get(unlinkMatch[1]) ?? [];
			linksByChannel.set(
				unlinkMatch[1],
				links.filter((link) => link.id !== unlinkMatch[2]),
			);
			return fulfillJson(route, { status: "unlinked" });
		}
		if (path.match(/^\/v1\/channels\/[^/]+\/(bindings|activity)$/)) return fulfillJson(route, []);
		if (path.match(/^\/v1\/channels\/[^/]+\/commands\/sync$/)) {
			return fulfillJson(route, { status: "ok" });
		}

		if (path === "/v1/ai-providers" && method === "GET") return fulfillJson(route, { providers });
		if (path === "/v1/ai-providers" && method === "POST") {
			const body = requestJson(route);
			const provider: JsonRecord = {
				...body,
				auth: body.auth ?? { type: "secret_ref" },
				models: body.models ?? [],
			};
			const index = providers.findIndex((item) => item.provider_id === provider.provider_id);
			if (index >= 0) providers[index] = provider;
			else providers.push(provider);
			return fulfillJson(route, provider);
		}
		const providerKeyMatch = path.match(/^\/v1\/ai-providers\/([^/]+)\/auth\/api-key$/);
		if (providerKeyMatch && method === "POST") {
			const provider = providers.find((item) => item.provider_id === providerKeyMatch[1]);
			if (provider) provider.auth = { type: "secret_ref", secret_ref: "clawdi://e2e/provider/key" };
			return fulfillJson(route, provider ?? { status: "ok" });
		}
		const providerValidateMatch = path.match(/^\/v1\/ai-providers\/([^/]+)\/validate$/);
		if (providerValidateMatch && method === "POST") {
			return fulfillJson(route, { valid: true, errors: [] });
		}
		const providerMatch = path.match(/^\/v1\/ai-providers\/([^/]+)$/);
		if (providerMatch && method === "DELETE") {
			const index = providers.findIndex((item) => item.provider_id === providerMatch[1]);
			if (index >= 0) providers.splice(index, 1);
			return fulfillJson(route, { status: "deleted" });
		}

		return fulfillJson(route, {});
	});
}

export function collectBrowserErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => {
		errors.push(error.message);
	});
	return errors;
}
