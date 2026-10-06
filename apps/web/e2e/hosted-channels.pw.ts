import { expect, test } from "@playwright/test";

import {
	collectBrowserErrors,
	expectContainedInOwnerAndViewport,
	expectNoHorizontalOverflow,
	missingProjectionEnvironmentId,
	runningMissingProjectionDeployment,
	stubHostedApi,
} from "./support/hosted-api-stub";

for (const firstTimeViewport of [
	{ label: "desktop", size: { width: 1440, height: 900 } },
	{ label: "320x568", size: { width: 320, height: 568 } },
] as const) {
	test(`first-time Agent connects, links, and pairs a Custom bot at ${firstTimeViewport.label}`, async ({
		page,
	}) => {
		await page.setViewportSize(firstTimeViewport.size);
		const errors = collectBrowserErrors(page);
		const channelId = "11111111-1111-4111-8111-111111111111";
		const linkId = "22222222-2222-4222-8222-222222222222";
		const channelAccounts: unknown[] = [];
		const channelAgentLinks: unknown[] = [];
		const channelBindings: unknown[] = [];
		const createChannelRequests: string[] = [];
		const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
		const pairCodeRequests: string[] = [];
		const validExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
		const channelAccount = {
			id: channelId,
			provider: "telegram",
			name: "Browser Telegram",
			status: "active",
			visibility: "private",
			has_provider_token: true,
			webhook_url: "https://cloud.example.test/channels/browser",
			created_at: "2026-07-27T12:00:00Z",
		};
		const channelLink = {
			id: linkId,
			account_id: channelId,
			agent_id: missingProjectionEnvironmentId,
			status: "active",
			created_at: "2026-07-27T12:00:00Z",
			binding_count: 0,
			account: channelAccount,
		};
		await stubHostedApi(page, {
			deployments: [runningMissingProjectionDeployment],
			channelAccounts,
			channelAgentLinks,
			channelBindings,
			createChannelRequests,
			createChannelResponse: {
				status: 201,
				delayMs: 1_500,
				body: {
					...channelAccount,
					webhook_secret: "one-time-webhook-secret",
					agent_link_id: linkId,
					agent_id: missingProjectionEnvironmentId,
					agent_token: "agent-custom-bot-token-must-not-render",
				},
			},
			onCreateChannel: () => {
				channelAccounts.push(channelAccount);
				channelAgentLinks.push(channelLink);
			},
			linkAgentRequests,
			pairCodeRequests,
			pairCodeResponses: [
				{
					status: 201,
					body: {
						id: "connected-bot-pair-code",
						agent_link_id: linkId,
						agent_id: missingProjectionEnvironmentId,
						code: "NPQRSTVWXY",
						expires_at: validExpiry,
						pairing_command: "/clawdi_pair NPQRSTVWXY",
						bot_username: "Browser_Telegram_Bot",
						deep_link: "https://t.me/Browser_Telegram_Bot?start=NPQRSTVWXY",
						qr_payload: "https://t.me/Browser_Telegram_Bot?start=NPQRSTVWXY",
					},
				},
			],
		});

		await page.goto(`/agents/${missingProjectionEnvironmentId}/channel-links`);
		const clawdiSection = page.locator('[data-agent-channel-section="clawdi"]');
		const customSection = page.locator('[data-agent-channel-section="custom"]');
		const unavailableHeading = page.getByRole("heading", { name: "Page Unavailable" });
		await expect(clawdiSection.or(unavailableHeading)).toBeVisible();
		if (await unavailableHeading.isVisible()) {
			await page.getByRole("button", { name: "Try Again", exact: true }).click();
		}
		await expect(clawdiSection.getByText("Clawdi bots", { exact: true })).toBeVisible();
		await expect(customSection.getByText("Custom bots", { exact: true })).toBeVisible();
		await expect(
			clawdiSection.getByText("No Clawdi bots available", { exact: true }),
		).toBeVisible();
		await expect(customSection.getByText("No custom bots yet", { exact: true })).toBeVisible();
		await expectNoHorizontalOverflow(page.locator("html"), `${firstTimeViewport.label} document`);
		await expectNoHorizontalOverflow(clawdiSection, `${firstTimeViewport.label} Clawdi bots`);
		await expectNoHorizontalOverflow(customSection, `${firstTimeViewport.label} Custom bots`);
		const connectCustom = customSection.getByRole("button", {
			name: "Add channel",
			exact: true,
		});
		await expect(connectCustom.getByText("Add channel", { exact: true })).toBeVisible();
		await expectContainedInOwnerAndViewport(
			page,
			connectCustom,
			customSection,
			`${firstTimeViewport.label} Add channel`,
		);

		await connectCustom.click();
		const connectDialog = page.getByRole("dialog", { name: "Add channel" });
		await expect(connectDialog).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(connectDialog).toContainText(
			"Add a custom bot you manage. When possible, it will be linked to this agent automatically.",
		);
		const agentInterfaceHint = connectDialog.locator("[data-other-provider-hint]");
		await expect(agentInterfaceHint).toContainText(
			"Need a provider that Clawdi Channels doesn't support?",
		);
		await expect(
			agentInterfaceHint.getByRole("link", { name: "Hermes Dashboard" }),
		).toHaveAttribute("href", `/agents/${missingProjectionEnvironmentId}/console`);
		await expect(agentInterfaceHint.locator('[data-slot="alert"]')).toHaveCount(0);
		await expect(connectDialog.locator("[data-agent-link-warning]")).toHaveCount(0);
		await expect(connectDialog.getByRole("status")).toContainText(
			"The new custom bot will be linked to this agent automatically.",
		);
		await connectDialog.getByRole("button", { name: "WhatsApp", exact: true }).click();
		await expect(connectDialog.getByRole("heading", { name: "Configure WhatsApp" })).toBeVisible();
		await expect(connectDialog.getByText("Clawdi WhatsApp", { exact: true })).toHaveCount(0);
		await expect(connectDialog.locator("[data-whatsapp-account-choice] section")).toHaveCount(0);
		await connectDialog.getByRole("button", { name: "Telegram", exact: true }).click();
		await expect(
			connectDialog.getByRole("button", { name: "Telegram", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await connectDialog.getByLabel("Name").fill("Browser Telegram");
		await connectDialog.getByLabel("Bot token").fill("123456:browser-test-token");
		await expectNoHorizontalOverflow(
			connectDialog,
			`${firstTimeViewport.label} Connect custom bot Dialog`,
		);
		for (const input of await connectDialog.locator("input").all()) {
			await expectContainedInOwnerAndViewport(
				page,
				input,
				connectDialog,
				`${firstTimeViewport.label} Custom bot credential input`,
			);
		}
		const submitCustomBot = connectDialog.getByRole("button", {
			name: "Add custom bot",
			exact: true,
		});
		await expectContainedInOwnerAndViewport(
			page,
			submitCustomBot,
			connectDialog,
			`${firstTimeViewport.label} Connect custom bot submit`,
		);

		await submitCustomBot.click();
		const connecting = connectDialog.getByRole("button", { name: "Adding…", exact: true });
		await expect(connecting).toBeVisible();
		for (const providerChoice of await connectDialog
			.getByRole("group", { name: "Choose provider" })
			.getByRole("button")
			.all()) {
			await expect(providerChoice).toBeDisabled();
		}
		await expectContainedInOwnerAndViewport(
			page,
			connecting,
			connectDialog,
			`${firstTimeViewport.label} pending Connect custom bot`,
		);

		await expect.poll(() => createChannelRequests.length).toBe(1);
		expect(JSON.parse(createChannelRequests[0] ?? "{}")).toEqual({
			provider: "telegram",
			name: "Browser Telegram",
			provider_token: "123456:browser-test-token",
			agent_id: missingProjectionEnvironmentId,
		});
		expect(linkAgentRequests).toEqual([]);

		await expect.poll(() => pairCodeRequests.length).toBe(1);
		const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
		await expect(connectDialog).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
		await expectNoHorizontalOverflow(
			pairDialog,
			`${firstTimeViewport.label} first-time Telegram Pair Dialog`,
		);
		await expectContainedInOwnerAndViewport(
			page,
			pairDialog.getByRole("button", { name: "Open Telegram" }),
			pairDialog,
			`${firstTimeViewport.label} first-time Open Telegram`,
		);

		expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
			ttl_seconds: 300,
			agent_link_id: linkId,
		});
		await expect(page.locator("body")).not.toContainText("agent-custom-bot-token-must-not-render");
		await page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname === "/v1/channels/agent-links" && response.request().method() === "GET";
		});
		const pairingObservedAt = Date.now();
		channelBindings.push({
			id: "33333333-3333-4333-8333-333333333333",
			account_id: channelId,
			agent_link_id: linkId,
			external_chat_id: "first-time-private-chat",
			external_chat_type: "private",
			external_chat_name: "First-time private chat",
			status: "active",
			created_at: "2026-08-01T01:00:00Z",
			last_message_at: null,
		});
		channelLink.binding_count = 1;
		await expect(pairDialog).toHaveCount(0, { timeout: 5_000 });
		const pairingElapsed = Date.now() - pairingObservedAt;
		console.log(
			`[channel-pairing-e2e] ${firstTimeViewport.label} polling convergence: ${pairingElapsed}ms`,
		);
		expect(pairingElapsed).toBeGreaterThanOrEqual(2_000);
		expect(pairingElapsed).toBeLessThan(4_500);
		const successToast = page.locator("[data-sonner-toast]").filter({ hasText: "Chat paired" });
		await expect(successToast).toHaveCount(1);
		await expect(successToast).toContainText("Telegram chat is ready.");
		await expectNoHorizontalOverflow(
			successToast,
			`${firstTimeViewport.label} first-time pair success toast`,
		);
		await expectContainedInOwnerAndViewport(
			page,
			successToast,
			page.locator("html"),
			`${firstTimeViewport.label} first-time pair success toast`,
		);

		await expect(page.getByText("No connected channels", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Browser Telegram", { exact: true }).first()).toBeVisible();
		await expect(
			page.locator(`[data-agent-paired-chats-trigger="${linkId}"]`),
		).toHaveAccessibleName("1 paired chat");
		expect(
			errors,
			`${firstTimeViewport.label} first-time channel path: ${errors.join(" | ")}`,
		).toEqual([]);
	});
}

test("channel detail links, pairs, and unlinks an Agent in place", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const errors = collectBrowserErrors(page);
	const channelId = "11111111-1111-4111-8111-111111111112";
	const agentId = "55555555-5555-4555-8555-555555555556";
	const linkId = "22222222-2222-4222-8222-222222222223";
	const sharedChannelId = "11111111-1111-4111-8111-111111111114";
	const sharedAgentId = "55555555-5555-4555-8555-555555555557";
	const sharedLinkId = "22222222-2222-4222-8222-222222222224";
	const channelAgentLinks: unknown[] = [];
	const linkAgentRequests: Array<{ accountId: string; body: string }> = [];
	const unlinkAgentRequests: string[] = [];
	const pairCodeRequests: string[] = [];
	const channelAccount = {
		id: channelId,
		provider: "telegram",
		name: "Channel Detail Telegram",
		status: "active",
		visibility: "private",
		has_provider_token: true,
		webhook_url: "https://cloud.example.test/channels/detail",
		created_at: "2026-08-20T12:00:00Z",
	};
	const channelLink = {
		id: linkId,
		account_id: channelId,
		agent_id: agentId,
		status: "active",
		runtime_status: "connecting",
		created_at: "2026-08-20T12:05:00Z",
	};
	const sharedChannelLink = {
		id: sharedLinkId,
		account_id: sharedChannelId,
		agent_id: sharedAgentId,
		status: "active",
		runtime_status: "connecting",
		created_at: "2026-08-20T12:04:00Z",
	};
	await stubHostedApi(page, {
		channelAccount,
		channelAccounts: [channelAccount],
		channelBotPool: {
			providers: {
				telegram: [
					{
						id: sharedChannelId,
						provider: "telegram",
						name: "Shared Channel Telegram",
						status: "active",
						visibility: "public",
						has_provider_token: true,
						webhook_url: "https://cloud.example.test/channels/shared",
						created_at: "2026-08-20T12:00:00Z",
						access: "public",
						capabilities: {
							link_agent: true,
							pair_chat: true,
							send_message: true,
							manage_account: false,
							sync_commands: false,
						},
						link_count: 0,
						max_links: null,
						available: true,
					},
				],
			},
		},
		channelAgentLinks,
		channelBindings: [],
		cloudAgents: [
			{
				id: agentId,
				name: "channel-agent",
				default_name: "Channel Agent",
				machine_name: "channel-agent.local",
				display_name: "Channel Agent",
				avatar_url: null,
				sort_order: 0,
				agent_type: "hermes",
				agent_version: "1.0.0",
				os: "linux",
				last_seen_at: "2026-08-20T12:00:00Z",
				last_sync_at: "2026-08-20T12:00:00Z",
			},
			{
				id: sharedAgentId,
				name: "shared-bot-agent",
				default_name: "Shared Bot Agent",
				machine_name: "shared-bot-agent.local",
				display_name: "Shared Bot Agent",
				avatar_url: null,
				sort_order: 1,
				agent_type: "hermes",
				agent_version: "1.0.0",
				os: "linux",
				last_seen_at: "2026-08-20T12:00:00Z",
				last_sync_at: "2026-08-20T12:00:00Z",
			},
		],
		linkAgentRequests,
		linkAgentResponses: [
			{ body: sharedChannelLink, status: 201 },
			{ body: channelLink, status: 201 },
		],
		onLinkAgent: (response) => channelAgentLinks.push(response),
		unlinkAgentRequests,
		onUnlinkAgent: () => channelAgentLinks.splice(0),
		pairCodeRequests,
		pairCodeResponses: [
			{
				status: 201,
				body: {
					id: "channel-list-pair-code",
					agent_link_id: sharedLinkId,
					agent_id: sharedAgentId,
					code: "LISTPAIR",
					expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
					pairing_command: "/clawdi_pair LISTPAIR",
					bot_username: "Channel_List_Bot",
					deep_link: "https://t.me/Channel_List_Bot?start=LISTPAIR",
					qr_payload: "https://t.me/Channel_List_Bot?start=LISTPAIR",
				},
			},
			{
				status: 201,
				body: {
					id: "channel-detail-pair-code",
					agent_link_id: linkId,
					agent_id: agentId,
					code: "DETAILPAIR",
					expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
					pairing_command: "/clawdi_pair DETAILPAIR",
					bot_username: "Channel_Detail_Bot",
					deep_link: "https://t.me/Channel_Detail_Bot?start=DETAILPAIR",
					qr_payload: "https://t.me/Channel_Detail_Bot?start=DETAILPAIR",
				},
			},
		],
	});

	await page.goto("/channels");
	const sharedBotCard = page.locator(`[data-shared-channel-account-id="${sharedChannelId}"]`);
	await sharedBotCard.getByRole("button", { name: "Link agent", exact: true }).click();
	const sharedBotLinkDialog = page.getByRole("dialog", { name: "Link agent" });
	await sharedBotLinkDialog.getByRole("combobox", { name: "Agent" }).click();
	await page.getByRole("option", { name: "Shared Bot Agent" }).click();
	await sharedBotLinkDialog.getByRole("button", { name: "Link agent", exact: true }).click();
	await expect
		.poll(() => linkAgentRequests)
		.toEqual([{ accountId: sharedChannelId, body: JSON.stringify({ agent_id: sharedAgentId }) }]);
	const sharedPairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(
		sharedPairDialog.getByRole("img", { name: "Telegram pairing QR code" }),
	).toBeVisible();
	await expect.poll(() => pairCodeRequests).toHaveLength(1);
	expect(JSON.parse(pairCodeRequests[0] ?? "{}")).toEqual({
		ttl_seconds: 300,
		agent_link_id: sharedLinkId,
	});
	await page.keyboard.press("Escape");
	await expect(sharedPairDialog).toHaveCount(0);
	await expect(page).toHaveURL("/channels");

	await page.goto(`/channels/${channelId}`);
	await expect(page.getByRole("heading", { name: "Channel Detail Telegram" })).toBeVisible();
	await page.getByRole("button", { name: "Link agent", exact: true }).click();
	const linkDialog = page.getByRole("dialog", { name: "Link agent" });
	await linkDialog.getByRole("combobox", { name: "Agent" }).click();
	await page.getByRole("option", { name: "Channel Agent" }).click();
	await linkDialog.getByRole("button", { name: "Link agent", exact: true }).click();

	await expect
		.poll(() => linkAgentRequests)
		.toEqual([
			{ accountId: sharedChannelId, body: JSON.stringify({ agent_id: sharedAgentId }) },
			{ accountId: channelId, body: JSON.stringify({ agent_id: agentId }) },
		]);
	const pairDialog = page.getByRole("dialog", { name: "Pair Telegram" });
	await expect(pairDialog.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
	await expect.poll(() => pairCodeRequests).toHaveLength(2);
	expect(JSON.parse(pairCodeRequests[1] ?? "{}")).toEqual({
		ttl_seconds: 300,
		agent_link_id: linkId,
	});
	await expect(page).toHaveURL(`/channels/${channelId}`);
	await expectNoHorizontalOverflow(pairDialog, "Channel detail pairing dialog");

	await page.keyboard.press("Escape");
	await expect(pairDialog).toHaveCount(0);

	const linkedAgent = page.locator(`[data-channel-agent-link-id="${linkId}"]`);
	await expect(linkedAgent.getByText("Channel Agent", { exact: true })).toBeVisible();
	await linkedAgent.getByRole("button", { name: "Unlink agent" }).click();
	const unlinkDialog = page.getByRole("alertdialog", { name: "Unlink agent?" });
	await unlinkDialog.getByRole("button", { name: "Unlink agent", exact: true }).click();
	await expect
		.poll(() => unlinkAgentRequests)
		.toEqual([`/v1/channels/${channelId}/agent-links/${linkId}`]);
	await expect(page.getByText("No agents linked", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(`/channels/${channelId}`);
	expect(errors, `channel detail relationship flow: ${errors.join(" | ")}`).toEqual([]);
});
