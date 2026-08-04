import { expect, type Page, type Route, test } from "@playwright/test";

const CLOUD_API = "http://127.0.0.1:8000";
const DEPLOY_API = "http://127.0.0.1:8001";
const now = "2026-08-02T12:00:00.000Z";
const agentId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "hdep_channel_convergence";
const telegramId = "22222222-2222-4222-8222-222222222222";
const telegramLinkId = "33333333-3333-4333-8333-333333333333";
const discordId = "44444444-4444-4444-8444-444444444444";
const discordLinkId = "55555555-5555-4555-8555-555555555555";
const whatsappId = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const whatsappLinkId = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const rawDiagnostic =
	"Authorization: Bot private-token; postgres://internal-db/tenant; upstream stack trace";

const agent = {
	id: agentId,
	name: "channel-convergence-agent",
	default_name: "Channel Convergence Agent",
	machine_name: "channel-convergence.local",
	display_name: "Channel Convergence Agent",
	avatar_url: null,
	sort_order: 0,
	agent_type: "hermes",
	agent_version: "1.0.0",
	os: "linux",
	last_seen_at: now,
	last_sync_at: now,
	last_sync_error: null,
	last_revision_seen: 1,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: true,
	default_project_id: "project-channel-convergence",
};

const telegram = {
	id: telegramId,
	provider: "telegram",
	name: "Support Telegram",
	status: "active",
	visibility: "private",
	has_provider_token: true,
	webhook_url: "https://example.test/channels/telegram",
	created_at: now,
};

const discord = {
	...telegram,
	id: discordId,
	provider: "discord",
	name: "Community Discord",
	webhook_url: "https://example.test/channels/discord",
};

const whatsapp = {
	...telegram,
	id: whatsappId,
	provider: "whatsapp",
	name: "Customer Care WhatsApp",
	webhook_url: null,
};

const links = [
	{
		id: telegramLinkId,
		account_id: telegramId,
		agent_id: agentId,
		status: "active",
		created_at: now,
		account: telegram,
		binding_count: 1,
	},
	{
		id: discordLinkId,
		account_id: discordId,
		agent_id: agentId,
		status: "active",
		created_at: now,
		account: discord,
		binding_count: 1,
	},
	{
		id: whatsappLinkId,
		account_id: whatsappId,
		agent_id: agentId,
		status: "active",
		created_at: now,
		account: whatsapp,
		binding_count: 0,
	},
];

const bindings = [
	{
		id: "66666666-6666-4666-8666-666666666666",
		account_id: telegramId,
		agent_link_id: telegramLinkId,
		external_chat_id: "telegram-chat-1",
		external_chat_type: "private",
		external_chat_name: "Customer support",
		status: "active",
		created_at: now,
		last_message_at: now,
	},
	{
		id: "77777777-7777-4777-8777-777777777777",
		account_id: discordId,
		agent_link_id: discordLinkId,
		external_chat_id: "discord-server-1",
		external_chat_type: "guild",
		external_chat_name: "Clawdi Community",
		status: "active",
		created_at: now,
		last_message_at: null,
	},
];

const health = {
	account_id: telegramId,
	provider: "telegram",
	name: telegram.name,
	visibility: "private",
	channel_status: "active",
	health_status: "error",
	reasons: ["failed_deliveries", "recent_error"],
	pending_inbox: 0,
	pending_deliveries: 0,
	in_progress_deliveries: 0,
	failed_deliveries: 1,
	last_message_at: now,
	last_event_at: now,
	last_error_at: now,
	last_error: rawDiagnostic,
	last_error_stage: "delivery",
	last_error_outcome: "failure",
	native_transport: null,
};

const deployment = {
	resource: {
		id: deploymentId,
		owner_user_id: "usr_browser",
		commercial_revision: 1,
		deployment_target: "saas",
		metadata: {
			generation: 1,
			manifestETag: `etag_${deploymentId}`,
			resourceVersion: `rv_${deploymentId}`,
			createdAt: now,
			updatedAt: now,
		},
		spec: {
			schema_version: 1,
			desired_lifecycle: "running",
			runtime: "hermes",
			runtime_version: "latest",
			name: "Channel Convergence Agent",
			resources: { vcpu: 2, memory_mib: 4096, disk_gib: 20 },
			agents: [],
			ports: [],
			runtime_configuration: { providers: [], features: [] },
			rollout_nonce: 0,
			secret_references: [],
		},
		status: {
			summary_state: "running",
			observedGeneration: 1,
			conditions: [],
			failure: null,
			backing_infrastructure: "present",
			driver_acknowledged_generation: 1,
			driver_applied_generation: 1,
			driver_observation_sequence: 1,
			endpoints: [],
		},
	},
	clawdi_cloud_environments: { hermes: agentId },
	ai_provider_auth_kinds: { hermes: "managed" },
	runtime_ui_endpoint: null,
	accepted_operation: null,
	commercial_display: { compute_subscription: null, latest_funding_fact: null },
	current_plan_slug: "compute_basic",
	upgrade_available: true,
	upgrade_eligibility: { eligible: true, reason: null },
	compute_slot_occupancy: {
		occupies_slot: true,
		backing_infra: "present",
		reason: "backing_infra_present",
	},
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubChannelExperience(page: Page) {
	const bindingsRefreshStarted = deferred();
	const releaseBindingsRefresh = deferred();
	let agentLinkReads = 0;
	let telegramBindingCount = 1;
	let telegramBindingReads = 0;
	let discordBindingReads = 0;
	let telegramPairRequests = 0;
	let whatsappPairRequests = 0;

	await page.route(`${DEPLOY_API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/me" || path === "/v1/me") {
			return fulfillJson(route, { capabilities: { can_use_v1: false, can_use_v2: true } });
		}
		if (path === "/v1/agent-environments") {
			return fulfillJson(route, { environment_ids: [] });
		}
		if (path === "/v2/deployments") return fulfillJson(route, [deployment]);
		if (path === `/v2/deployments/${deploymentId}`) return fulfillJson(route, deployment);
		return fulfillJson(route, {});
	});

	await page.route(`${CLOUD_API}/v1/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		if (path === "/v1/me") {
			return fulfillJson(route, { capabilities: { can_use_v1: false, can_use_v2: true } });
		}
		if (path === "/v1/agents") return fulfillJson(route, [agent]);
		if (path === `/v1/agents/${agentId}`) return fulfillJson(route, agent);
		if (path === "/v1/channels" && request.method() === "GET") {
			return fulfillJson(route, [telegram, discord, whatsapp]);
		}
		if (path === "/v1/channels/bot-pool") {
			return fulfillJson(route, { providers: {} });
		}
		if (path === "/v1/channels/agent-links") {
			agentLinkReads += 1;
			return fulfillJson(
				route,
				links.map((link) =>
					link.id === telegramLinkId ? { ...link, binding_count: telegramBindingCount } : link,
				),
			);
		}
		if (path === "/v1/channels/health") return fulfillJson(route, { items: [health] });
		if (path === `/v1/channels/${telegramId}`) return fulfillJson(route, telegram);
		if (path === `/v1/channels/${discordId}`) return fulfillJson(route, discord);
		if (path === `/v1/channels/${whatsappId}`) return fulfillJson(route, whatsapp);
		if (path === `/v1/channels/${telegramId}/agent-links`) {
			return fulfillJson(route, [links[0]]);
		}
		if (path === `/v1/channels/${discordId}/agent-links`) {
			return fulfillJson(route, [links[1]]);
		}
		if (path === `/v1/channels/${whatsappId}/agent-links`) {
			return fulfillJson(route, [links[2]]);
		}
		if (path === `/v1/channels/${telegramId}/bindings`) {
			telegramBindingReads += 1;
			if (telegramBindingReads === 2) {
				bindingsRefreshStarted.resolve();
				await releaseBindingsRefresh.promise;
			}
			return fulfillJson(
				route,
				bindings.filter((binding) => binding.account_id === telegramId),
			);
		}
		if (path === `/v1/channels/${discordId}/bindings`) {
			discordBindingReads += 1;
			return fulfillJson(
				route,
				bindings.filter((binding) => binding.account_id === discordId),
			);
		}
		if (path === `/v1/channels/${telegramId}/activity`) {
			return fulfillJson(route, {
				items: [
					{
						kind: "message",
						id: "88888888-8888-4888-8888-888888888888",
						account_id: telegramId,
						provider: "telegram",
						direction: "outbound",
						external_chat_id: "telegram-chat-1",
						delivery_status: "failed",
						delivery_last_error: rawDiagnostic,
						text: "Hello",
						created_at: now,
						updated_at: now,
					},
				],
			});
		}
		if (path === `/v1/channels/${telegramId}/pair-codes` && request.method() === "POST") {
			telegramPairRequests += 1;
			if (telegramPairRequests === 1) {
				return fulfillJson(route, { detail: rawDiagnostic }, 503);
			}
			return fulfillJson(
				route,
				{
					id: "99999999-9999-4999-8999-999999999999",
					agent_link_id: telegramLinkId,
					agent_id: agentId,
					code: "BCDFGHJKLM",
					expires_at: new Date(Date.now() + 300_000).toISOString(),
					pairing_command: "/clawdi_pair BCDFGHJKLM",
					bot_username: "Clawdi_Support_Bot",
					deep_link: "https://t.me/Clawdi_Support_Bot?start=BCDFGHJKLM",
					qr_payload: "https://t.me/Clawdi_Support_Bot?start=BCDFGHJKLM",
				},
				201,
			);
		}
		if (path === `/v1/channels/${discordId}/pair-codes` && request.method() === "POST") {
			return fulfillJson(
				route,
				{
					id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					agent_link_id: discordLinkId,
					agent_id: agentId,
					code: "HJKLMNPQRS",
					expires_at: new Date(Date.now() + 300_000).toISOString(),
					pairing_command: "/clawdi_pair HJKLMNPQRS",
					discord_install_url:
						"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=274878024768&scope=bot%20applications.commands",
					discord_user_install_url:
						"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands",
				},
				201,
			);
		}
		if (path === `/v1/channels/${whatsappId}/pair-codes` && request.method() === "POST") {
			whatsappPairRequests += 1;
			if (whatsappPairRequests === 1) {
				return fulfillJson(route, { detail: rawDiagnostic }, 503);
			}
			const code = whatsappPairRequests === 2 ? "EXPIREDWA" : "FRESHWACODE";
			return fulfillJson(
				route,
				{
					id: "cccccccc-3333-4ccc-8ccc-cccccccccccc",
					agent_link_id: whatsappLinkId,
					agent_id: agentId,
					code,
					expires_at: new Date(
						Date.now() + (whatsappPairRequests === 2 ? -1_000 : 300_000),
					).toISOString(),
					pairing_command: `/clawdi_pair ${code}`,
				},
				201,
			);
		}
		if (path === "/v1/projects") return fulfillJson(route, []);
		if (path === "/v1/sessions") {
			return fulfillJson(route, { items: [], total: 0, page: 1, page_size: 25 });
		}
		return fulfillJson(route, {});
	});

	return {
		bindingsRefreshStarted,
		releaseBindingsRefresh,
		agentLinkReads: () => agentLinkReads,
		incrementTelegramBindingCount: () => {
			telegramBindingCount += 1;
		},
		telegramBindingReads: () => telegramBindingReads,
		discordBindingReads: () => discordBindingReads,
		telegramPairRequests: () => telegramPairRequests,
		whatsappPairRequests: () => whatsappPairRequests,
	};
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.locator("html").evaluate((element) => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

for (const viewport of [
	{ label: "desktop", width: 1440, height: 1000 },
	{ label: "320px", width: 320, height: 720 },
]) {
	test(`Telegram, Discord, and WhatsApp cards, chats, and pairing converge at ${viewport.label}`, async ({
		page,
	}) => {
		test.setTimeout(45_000);
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		const api = await stubChannelExperience(page);
		await page.goto(`/agents/${agentId}/channel-links?source=on-clawdi&d=${deploymentId}`);

		const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" });
		await expect(breadcrumb.getByRole("link", { name: "Channels", exact: true })).toBeVisible();
		const telegramCard = page.locator(`[data-agent-channel-link-id="${telegramLinkId}"]`);
		const discordCard = page.locator(`[data-agent-channel-link-id="${discordLinkId}"]`);
		const whatsappCard = page.locator(`[data-agent-channel-link-id="${whatsappLinkId}"]`);
		await expect(telegramCard).toContainText(telegram.name);
		await expect(discordCard).toContainText(discord.name);
		await expect(whatsappCard).toContainText(whatsapp.name);
		await expect(telegramCard.getByRole("button", { name: "Pair", exact: true })).toHaveCount(1);
		await expect(discordCard.getByRole("button", { name: "Pair", exact: true })).toHaveCount(1);
		await expect(whatsappCard.getByRole("button", { name: "Pair", exact: true })).toHaveCount(1);
		await expect(telegramCard.locator("footer, [data-channel-card-footer]")).toHaveCount(0);
		await expect(discordCard.locator("footer, [data-channel-card-footer]")).toHaveCount(0);

		const telegramChats = page.locator(`[data-agent-paired-chats-trigger="${telegramLinkId}"]`);
		await expect(telegramChats).toHaveAccessibleName("1 paired chat");
		expect(api.telegramBindingReads()).toBe(0);
		expect(api.discordBindingReads()).toBe(0);
		for (const minimumReads of [2, 3]) {
			await expect.poll(api.agentLinkReads).toBeGreaterThanOrEqual(minimumReads);
			await expect(telegramChats).toHaveAccessibleName("1 paired chat");
			await expect(telegramChats.locator(".animate-spin")).toHaveCount(0);
			await expect(telegramCard.locator(".animate-pulse")).toHaveCount(0);
		}
		expect(api.telegramBindingReads()).toBe(0);
		expect(api.discordBindingReads()).toBe(0);

		await telegramChats.click();
		const pairedChats = page.locator(`[data-agent-channel-chats-for="${telegramLinkId}"]`);
		await expect(pairedChats.getByRole("heading", { name: "Paired chats" })).toBeVisible();
		await expect(pairedChats).toContainText("Customer support");
		await expect.poll(api.telegramBindingReads).toBe(1);
		await api.bindingsRefreshStarted.promise;
		try {
			await expect(pairedChats).toContainText("Customer support");
			await expect(pairedChats.getByText("Loading paired chats")).toHaveCount(0);
			await expect(pairedChats.locator(".animate-pulse")).toHaveCount(0);
		} finally {
			api.releaseBindingsRefresh.resolve();
		}
		await page.keyboard.press("Escape");
		await expect(pairedChats).toHaveCount(0);
		await expect(telegramChats).toBeFocused();
		const bindingReadsAfterClose = api.telegramBindingReads();
		await page.waitForTimeout(3_500);
		expect(api.telegramBindingReads()).toBe(bindingReadsAfterClose);

		const telegramPair = telegramCard.getByRole("button", { name: "Pair", exact: true });
		await telegramPair.click();
		let pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
		await expect(pairDialog).toContainText(
			"Telegram pairing is temporarily unavailable. Try again.",
		);
		await expect(pairDialog).not.toContainText(rawDiagnostic);
		await pairDialog.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(api.telegramPairRequests).toBe(2);
		await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
		api.incrementTelegramBindingCount();
		await expect(pairDialog).toHaveCount(0);
		await expect(page.getByText("Chat paired", { exact: true })).toBeVisible();
		await expect(telegramChats).toHaveAccessibleName("2 paired chats");
		expect(api.telegramBindingReads()).toBe(bindingReadsAfterClose);

		await telegramPair.click();
		pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
		await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
		const aggregateReadsAtReopen = api.agentLinkReads();
		await expect.poll(api.agentLinkReads).toBeGreaterThan(aggregateReadsAtReopen);
		await expect(pairDialog).toBeVisible();
		expect(api.telegramBindingReads()).toBe(bindingReadsAfterClose);
		await page.keyboard.press("Escape");
		await expect(pairDialog).toHaveCount(0);
		await expect(telegramPair).toBeFocused();

		await discordCard.getByRole("button", { name: "Pair", exact: true }).click();
		pairDialog = page.getByRole("dialog", { name: "Pair Discord" });
		await expect(
			pairDialog.getByRole("img", { name: "Discord server install QR code" }),
		).toBeVisible();
		await expect(pairDialog.getByRole("tab", { name: "Direct message" })).toBeEnabled();
		expect(api.discordBindingReads()).toBe(0);
		await page.keyboard.press("Escape");
		await expect(pairDialog).toHaveCount(0);
		await expectNoHorizontalOverflow(page);

		const whatsappPair = whatsappCard.getByRole("button", { name: "Pair", exact: true });
		await whatsappPair.click();
		pairDialog = page.getByRole("dialog", { name: "Pair WhatsApp" });
		await expect(pairDialog).toContainText(
			"WhatsApp pairing is temporarily unavailable. Try again.",
		);
		await expect(pairDialog).not.toContainText(rawDiagnostic);
		await expect(whatsappCard).not.toContainText("Pair failed");
		await pairDialog.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(api.whatsappPairRequests).toBe(2);
		await expect(pairDialog).toContainText("This WhatsApp pair code has expired");
		await expect(pairDialog).toContainText("Expired — generate a new code");
		await pairDialog.getByRole("button", { name: "Generate new code", exact: true }).click();
		await expect.poll(api.whatsappPairRequests).toBe(3);
		const whatsappCommand = pairDialog.getByRole("button", {
			name: "Copy WhatsApp pairing command",
		});
		await expect(whatsappCommand).toContainText("/clawdi_pair FRESHWACODE");
		await expect(whatsappCard).not.toContainText("/clawdi_pair");
		await expect(pairDialog.getByText(/^Expires in /)).toBeVisible();
		await whatsappCommand.click();
		await expect(
			pairDialog.getByRole("button", { name: "WhatsApp pairing command copied" }),
		).toBeVisible();
		await expectNoHorizontalOverflow(page);
		await page.keyboard.press("Escape");
		await expect(pairDialog).toHaveCount(0);
		await expect(whatsappPair).toBeFocused();
	});
}

test("channel activity and health never expose backend diagnostics", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await stubChannelExperience(page);
	await page.goto(`/channels/${telegramId}`);

	await expect(
		page.getByText("Message delivery failed. Check the channel connection and try again."),
	).toBeVisible();
	await expect(page.getByText(rawDiagnostic, { exact: true })).toHaveCount(0);
	await page.getByRole("tab", { name: "Health", exact: true }).click();
	await expect(
		page.getByText("Message delivery failed. Check the channel connection and try again."),
	).toBeVisible();
	await expect(page.getByText(rawDiagnostic, { exact: true })).toHaveCount(0);
});
