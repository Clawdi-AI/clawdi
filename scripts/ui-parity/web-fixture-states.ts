#!/usr/bin/env bun
/** Verify fixture-backed product flows and capture their real Web surfaces. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page, expect as playwrightExpect } from "@playwright/test";

const expect = playwrightExpect.configure({ timeout: 30000 });

function flag(name: string, fallback: string) {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}
const baseUrl = flag("base-url", "http://127.0.0.1:3217");
const apiUrl = flag("api-url", "http://127.0.0.1:8791");
const output = flag("out", "/tmp/clawdi-ui-parity/web-fixture-states");
const project = "a0f1c2d3-0002-4a00-8000-000000000002";
const agent = "0c1a3000-0004-4c00-8000-000000000004";
const channel = "c4a00000-0001-4000-8000-000000000001";
const session = "5e550000-0001-4000-8000-000000000001";
const projectToken = "fixture_project_acme_".padEnd(43, "0");
const vaultToken = `v2_${"fixture_acme_".padEnd(43, "0")}`;
const manifest: { theme: string; name: string; file: string }[] = [];
const failures: string[] = [];
const only = flag("only", "").split(",").filter(Boolean);

async function settings(value: Record<string, string | null>) {
	const response = await fetch(new URL("/v1/settings", apiUrl), {
		method: "PATCH",
		headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
		body: JSON.stringify({ settings: value }),
	});
	if (!response.ok) throw new Error(`Settings fixture returned ${response.status}`);
}
async function newSupplyUrl() {
	const response = await fetch(new URL("/v1/vault/requests", apiUrl), {
		method: "POST",
		headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
		body: JSON.stringify({
			vault_id: "7a017000-0002-4000-8000-000000000002",
			project_id: project,
			slug: "acme-prod",
			section: "(default)",
			fields: ["DEPLOY_TOKEN", "DATABASE_URL"],
			expires_in_seconds: 3600,
		}),
	});
	if (!response.ok) throw new Error(`Supply creation returned ${response.status}`);
	const body: unknown = await response.json();
	if (
		typeof body !== "object" ||
		body === null ||
		!("url" in body) ||
		typeof body.url !== "string"
	) {
		throw new Error("Invalid fixture supply URL");
	}
	const url = new URL(body.url);
	return url.pathname + url.hash;
}
async function visit(page: Page, path: string) {
	await page.goto(new URL(path, baseUrl).toString(), { waitUntil: "networkidle" });
}
async function capture(page: Page, theme: string, name: string, marker: string | RegExp) {
	const target = page.getByText(marker).first();
	await expect(target).toBeVisible();
	await target.scrollIntoViewIfNeeded();
	await expect(target).toBeInViewport();
	const file = join(output, theme, `${name}.png`);
	const modal =
		(await page.getByRole("dialog").count()) + (await page.getByRole("alertdialog").count());
	await page.screenshot({
		path: file,
		fullPage: modal === 0 && name !== "received-invitations",
		animations: "disabled",
	});
	manifest.push({ theme, name, file });
	console.log(`${theme} ${name}: verified`);
}
async function shareProject(page: Page) {
	await visit(page, `/projects/${project}`);
	await page.getByRole("tab", { name: "Access", exact: true }).click();
	await page.getByRole("button", { name: "Manage sharing", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
}
async function runCase(name: string, page: Page, action: () => Promise<void>) {
	if (only.length && !only.some((item) => name.endsWith(`-${item}`))) return;
	try {
		// Token intake is intentionally one-shot per document. Isolate each scenario.
		await page.goto("about:blank");
		await action();
	} catch (error) {
		failures.push(`${name}: ${String(error)}`);
		await writeFile(join(output, `${name}-failure.txt`), await page.locator("body").innerText());
		console.error(failures[failures.length - 1]);
	}
}

async function main() {
	await mkdir(output, { recursive: true });
	const browser = await chromium.launch();
	try {
		for (const theme of ["light", "dark"]) {
			await mkdir(join(output, theme), { recursive: true });
			const context = await browser.newContext({
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 3,
				isMobile: true,
				hasTouch: true,
				reducedMotion: "reduce",
				colorScheme: theme === "dark" ? "dark" : "light",
				timezoneId: "America/Los_Angeles",
			});
			await context.addInitScript((value) => localStorage.setItem("clawdi-theme", value), theme);
			const page = await context.newPage();
			page.setDefaultTimeout(30000);
			page.on("response", (response) => {
				if (
					response.status() >= 400 &&
					new URL(response.url()).origin === new URL(apiUrl).origin &&
					!response.url().includes("/content-events") &&
					!(
						response.status() === 409 &&
						response.url().endsWith("/channels/c4a00000-0003-4000-8000-000000000003/agent-links")
					)
				) {
					failures.push(`${theme}: API ${response.status()} ${response.url()}`);
				}
			});
			await runCase(`${theme}-invitations`, page, async () => {
				await visit(page, "/projects");
				await page.getByRole("button", { name: /Notifications.*2/i }).click();
				await expect(page.getByRole("button", { name: /Accept/ }).first()).toBeEnabled();
				await expect(page.getByRole("button", { name: /Decline/ }).first()).toBeEnabled();
				await capture(page, theme, "received-invitations", "Partner Research");
			});
			await runCase(`${theme}-sharing`, page, async () => {
				await shareProject(page);
				await capture(page, theme, "project-sharing", "sam@acme.dev");
				await page
					.getByRole("button", { name: /Turn off invite link/ })
					.first()
					.click();
				await capture(page, theme, "project-link-revoke", /Turn off.*link/i);
				await page
					.getByRole("alertdialog")
					.getByRole("button", { name: "Cancel", exact: true })
					.click();
				await page.getByRole("button", { name: "Cancel invitation for sam@acme.dev" }).click();
				await capture(page, theme, "project-invitation-revoke", /Cancel invitation/i);
			});
			await runCase(`${theme}-invite-result`, page, async () => {
				await shareProject(page);
				await page.getByRole("button", { name: /Create invite link/ }).click();
				await capture(page, theme, "project-link-created", "Copy this link now");
			});
			await runCase(`${theme}-project-preview`, page, async () => {
				await visit(page, `/share/${projectToken}`);
				await capture(page, theme, "project-invite-preview", "Acme Web App");
				await expect(page.getByRole("button", { name: /Accept|Join/ }).first()).toBeEnabled();
			});
			await runCase(`${theme}-api-key`, page, async () => {
				await visit(page, "/?settings=api-keys");
				await page.getByRole("button", { name: "Create API key", exact: true }).click();
				await page.getByLabel("Key name", { exact: true }).fill(`Fixture ${theme}`);
				await page
					.getByRole("dialog")
					.last()
					.getByRole("button", { name: "Create API key", exact: true })
					.click();
				await capture(page, theme, "api-key-one-time", "Save your API key");
				await expect(page.getByText(/clawdi_fixture_only_/)).toBeVisible();
			});
			await runCase(`${theme}-mem0`, page, async () => {
				await settings({ memory_provider: "builtin", mem0_api_key: null });
				await visit(page, "/memories");
				await page.getByRole("button", { name: "Mem0", exact: true }).click();
				await capture(page, theme, "mem0-unconfigured", /Mem0 API key/);
				await settings({ mem0_api_key: "fixture-only" });
				await page.reload({ waitUntil: "networkidle" });
				await expect(page.getByLabel("Mem0 API key", { exact: true })).toHaveCount(0);
				await capture(page, theme, "mem0-configured", "Create memory");
			});
			await runCase(`${theme}-vault-split`, page, async () => {
				await visit(page, "/vaults/acme-prod");
				await page.getByRole("button", { name: "Split into vaults…" }).click();
				await capture(page, theme, "vault-prefix-split", /Split.*Acme Production/i);
				await expect(page.getByLabel("Destination slug for stripe/", { exact: true })).toHaveValue(
					"stripe",
				);
				await expect(page.getByLabel("Destination slug for sentry/", { exact: true })).toHaveValue(
					"sentry",
				);
			});
			await runCase(`${theme}-vault-supply`, page, async () => {
				await visit(page, `/vault-request#${vaultToken}`);
				await capture(page, theme, "vault-supply", "DEPLOY_TOKEN");
				await expect(page.getByText("DATABASE_URL", { exact: true }).first()).toBeVisible();
			});
			await runCase(`${theme}-vault-receipt`, page, async () => {
				await visit(page, await newSupplyUrl());
				await page.getByLabel("DEPLOY_TOKEN", { exact: true }).fill("fixture-deploy-placeholder");
				await page.getByLabel("DATABASE_URL", { exact: true }).fill("fixture-database-placeholder");
				await page.getByRole("button", { name: "Save secrets", exact: true }).click();
				await capture(
					page,
					theme,
					"vault-supply-receipt",
					"Your secrets are saved. Send this message to your agent to continue.",
				);
			});
			await runCase(`${theme}-connector`, page, async () => {
				await visit(page, "/connectors/stripe");
				await page.getByRole("button", { name: "Connect account", exact: true }).first().click();
				await capture(page, theme, "connector-api-key", "API key");
				await expect(page.getByLabel(/API key/)).toBeVisible();
			});
			await runCase(`${theme}-provider-oauth`, page, async () => {
				await visit(page, "/ai-providers");
				await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
				await page.getByRole("button", { name: "OpenAI", exact: true }).click();
				await page.getByRole("button", { name: /ChatGPT/ }).click();
				await page.getByLabel("Name", { exact: true }).fill(`Fixture ChatGPT ${theme}`);
				await page.getByRole("button", { name: "Continue to ChatGPT", exact: true }).click();
				await capture(page, theme, "provider-oauth-code", "FIXT-URE1");
				await expect(page.getByRole("dialog")).toHaveCount(0);
				await capture(page, theme, "provider-oauth-result", "Signed in with ChatGPT");
			});
			await runCase(`${theme}-plugins`, page, async () => {
				await visit(page, `/agents/${agent}/plugins`);
				await capture(page, theme, "plugins-inventory", "Project Notes");
				await expect(page.getByText("Code Review", { exact: true })).toBeVisible();
				await page.getByRole("button", { name: "Install", exact: true }).click();
				await expect(
					page.getByRole("button", { name: "Remove Code Review", exact: true }),
				).toBeVisible();
				await capture(page, theme, "plugin-installed", "Code Review");
				await page.getByRole("button", { name: "Remove Code Review", exact: true }).click();
				await capture(page, theme, "plugin-remove", "Remove Code Review?");
				await page.getByRole("button", { name: "Remove plugin", exact: true }).click();
				await expect(page.getByRole("button", { name: "Install", exact: true })).toBeVisible();
			});
			await runCase(`${theme}-paired-chats`, page, async () => {
				await visit(page, `/agents/${agent}/channel-links`);
				await page.getByRole("button", { name: "2 paired chats", exact: true }).click();
				await capture(page, theme, "channel-paired-chats", "Acme Ops");
				await page.getByRole("button", { name: "Unpair Avery Chen", exact: true }).click();
				await capture(page, theme, "channel-unpair-chat", "Unpair Avery Chen?");
			});
			await runCase(`${theme}-channel-pair`, page, async () => {
				await visit(page, `/channels/${channel}`);
				await page.getByRole("button", { name: "Pair chat", exact: true }).click();
				await expect(page.getByRole("img", { name: "Telegram pairing QR code" })).toBeVisible();
				await page.getByText("Pair manually", { exact: true }).click();
				await capture(page, theme, "channel-pair-code", "/pair FIXTURE42");
			});
			await runCase(`${theme}-channel-link`, page, async () => {
				await visit(page, `/channels/${channel}`);
				await page.getByRole("button", { name: "Link Agent", exact: true }).click();
				await capture(page, theme, "channel-link-agent", /Link.*Agent/i);
			});
			await runCase(`${theme}-channel-replace`, page, async () => {
				await visit(page, "/channels/c4a00000-0004-4000-8000-000000000004");
				await page.getByRole("button", { name: "Link Agent", exact: true }).click();
				await page.getByRole("combobox").click();
				await page.getByRole("option", { name: "OpenClaw", exact: true }).click();
				await page
					.getByRole("dialog")
					.getByRole("button", { name: "Link Agent", exact: true })
					.click();
				await capture(page, theme, "channel-replace-link", /Replace.*Telegram/i);
			});
			await runCase(`${theme}-channel-unlink`, page, async () => {
				await visit(page, `/channels/${channel}`);
				await page.getByRole("button", { name: "Unlink Agent", exact: true }).click();
				await capture(page, theme, "channel-unlink-agent", /Unlink.*Agent/i);
			});
			await runCase(`${theme}-channel-commands`, page, async () => {
				await visit(page, `/channels/${channel}`);
				await page.getByRole("tab", { name: "Commands", exact: true }).click();
				await capture(page, theme, "channel-commands", /Publish|Sync commands/);
				await page.getByRole("button", { name: "Publish commands", exact: true }).click();
				await capture(page, theme, "channel-commands-published", "/ask");
			});
			await runCase(`${theme}-whatsapp`, page, async () => {
				await visit(page, "/channels");
				await page.getByRole("button", { name: "Add channel", exact: true }).click();
				await page.getByRole("button", { name: /WhatsApp/ }).click();
				await page.getByRole("button", { name: "Connect your account" }).click();
				await page.getByLabel("Account name", { exact: true }).fill("Fixture WhatsApp");
				await page.getByRole("button", { name: /Generate QR/ }).click();
				await capture(page, theme, "whatsapp-qr", /Linked devices/);
				await page.getByText("Can't scan? Use a pairing code", { exact: true }).click();
				await page.getByLabel("WhatsApp phone number").fill("15555550123");
				await page.getByRole("button", { name: /pairing code/i }).click();
				await capture(page, theme, "whatsapp-pairing-code", "1234-5678");
				await page.getByRole("button", { name: "Cancel connection" }).click();
			});
			await runCase(`${theme}-whatsapp-repair`, page, async () => {
				await visit(page, "/channels/c4a00000-0003-4000-8000-000000000003");
				await page.getByRole("button", { name: "Link Agent", exact: true }).click();
				await page.getByRole("combobox").click();
				await page.getByRole("option", { name: "OpenClaw", exact: true }).click();
				await page
					.getByRole("dialog")
					.getByRole("button", { name: "Link Agent", exact: true })
					.click();
				await capture(page, theme, "whatsapp-repair", "Repair WhatsApp before linking");
			});
			await runCase(`${theme}-session-share`, page, async () => {
				await visit(page, `/sessions/${session}`);
				await page.getByRole("button", { name: "Share", exact: true }).first().click();
				await capture(page, theme, "session-existing-shares", /Share session|Share this session/i);
				const shareUrl = page.getByLabel("Session share URL").first();
				const previous = await shareUrl.inputValue();
				await page.getByRole("button", { name: "Create new snapshot", exact: true }).click();
				await expect(shareUrl).not.toHaveValue(previous);
				await capture(page, theme, "session-snapshot-created", /Share session|Share this session/i);
				await page
					.getByRole("button", { name: "Turn off share link", exact: true })
					.first()
					.click();
				await capture(page, theme, "session-share-revoke", "Turn off this share link?");
				await page.getByRole("button", { name: "Turn off link", exact: true }).click();
				await expect(page.getByRole("alertdialog")).toHaveCount(0);
				await expect(shareUrl).toHaveValue(previous);
			});
			for (const [index, state] of ["stopped", "failed", "starting", "dunning"].entries()) {
				await runCase(`${theme}-deployment-${state}`, page, async () => {
					const id = `4e2e5000-000${index + 5}-4c00-8000-00000000000${index + 5}`;
					await visit(page, `/agents/${id}`);
					await capture(
						page,
						theme,
						`deployment-${state}`,
						state === "dunning" ? /payment|past due|overdue/i : new RegExp(state, "i"),
					);
				});
			}
			await runCase(`${theme}-dunning-billing`, page, async () => {
				await visit(page, "/?settings=api-keys");
				await page.getByRole("button", { name: /^Compute/ }).click();
				await capture(page, theme, "billing-dunning", /^Past due$/);
			});
			await context.close();
		}
	} finally {
		await browser.close();
		await settings({ memory_provider: "builtin", mem0_api_key: null });
		await writeFile(
			join(output, "manifest.json"),
			JSON.stringify({ captures: manifest, failures }, null, 2),
		);
	}
	if (failures.length)
		throw new Error(`${failures.length} Web verification failures; see manifest.json`);
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
