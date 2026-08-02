import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	agentProviderHasSingleLinkLimit,
	availableBotProvidersForAgent,
	channelProviderLinkingReady,
	pairCodeExpired,
	pairingCommand,
	verifiedDiscordInstallUrl,
	verifiedDiscordPairingCommand,
} from "./channel-linking.logic";

function productionTypeScriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return productionTypeScriptFiles(entryPath);
		if (
			!entry.isFile() ||
			!/\.(?:ts|tsx)$/.test(entry.name) ||
			/\.test\.(?:ts|tsx)$/.test(entry.name)
		) {
			return [];
		}
		return [entryPath];
	});
}

describe("hosted channel instructions and gates", () => {
	test("renders the exact command accepted by the channel backend", () => {
		expect(pairingCommand("BCDFGHJKLM")).toBe("/clawdi_pair BCDFGHJKLM");
	});

	test("accepts only the current authoritative Discord pairing command", () => {
		expect(verifiedDiscordPairingCommand("/clawdi_pair BCDFGHJKLM", "BCDFGHJKLM")).toBe(
			"/clawdi_pair BCDFGHJKLM",
		);
		expect(verifiedDiscordPairingCommand("/bot_pair BCDFGHJKLM", "BCDFGHJKLM")).toBeNull();
		expect(verifiedDiscordPairingCommand("/clawdi_pair OTHER", "BCDFGHJKLM")).toBeNull();
		expect(verifiedDiscordPairingCommand(" /clawdi_pair BCDFGHJKLM", "BCDFGHJKLM")).toBeNull();
	});

	test("accepts backend-owned Discord install policy across split deploys", () => {
		for (const supported of [
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=274878024768&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=0&permissions=309237763136&scope=bot%20applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands",
		]) {
			expect(verifiedDiscordInstallUrl(supported)).toBe(supported);
		}
	});

	test("renders the canonical serialization of the URL that passed validation", () => {
		const nonCanonical =
			"\nHTTPS://DISCORD.COM:443/oauth2/temporary/../authorize?client_id=123456789012345678&scope=bot+applications.commands\t";
		expect(verifiedDiscordInstallUrl(nonCanonical)).toBe(
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot+applications.commands",
		);
	});

	test("rejects malformed, non-Discord, redirecting, and ambiguous install URLs", () => {
		for (const unsupported of [
			null,
			undefined,
			"not-a-url",
			"http://discord.com/oauth2/authorize?client_id=123456789012345678",
			"https://example.com/oauth2/authorize?client_id=123456789012345678",
			"https://discord.com.example.test/oauth2/authorize?client_id=123456789012345678",
			"https://discord.com@evil.example/oauth2/authorize?client_id=123456789012345678",
			"https://user:password@discord.com/oauth2/authorize?client_id=123456789012345678",
			"https://discord.com/api/oauth2/authorize?client_id=123456789012345678",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678#token",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&redirect_uri=https%3A%2F%2Fevil.example",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&response_type=code",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&client_id=987654321098765432",
			"https://discord.com/oauth2/authorize?client_id=123&scope=bot",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&scope=applications.commands",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=",
			"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=%",
		]) {
			expect(verifiedDiscordInstallUrl(unsupported)).toBeNull();
		}
	});

	test("keeps Discord permission policy out of Web production source", () => {
		const webSourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
		for (const sourceFile of productionTypeScriptFiles(webSourceRoot)) {
			expect(readFileSync(sourceFile, "utf8")).not.toMatch(/\b(?:274878024768|309237763136)\b/);
		}
	});

	test("selects the first unlinked provider and exposes no form when both are linked", () => {
		expect(availableBotProvidersForAgent("agent-1", "openclaw", new Set())).toEqual([
			"telegram",
			"discord",
		]);
		expect(availableBotProvidersForAgent("agent-1", "openclaw", new Set(["telegram"]))).toEqual([
			"discord",
		]);
		expect(
			availableBotProvidersForAgent("agent-1", "openclaw", new Set(["telegram", "discord"])),
		).toEqual([]);
		expect(
			availableBotProvidersForAgent(undefined, undefined, new Set(["telegram", "discord"])),
		).toEqual(["telegram", "discord"]);
	});

	test("expires pairing actions exactly at the server deadline", () => {
		const deadline = "2026-07-30T12:00:00Z";
		expect(pairCodeExpired(deadline, Date.parse("2026-07-30T11:59:59Z"))).toBe(false);
		expect(pairCodeExpired(deadline, Date.parse(deadline))).toBe(true);
		expect(pairCodeExpired(deadline, Date.parse("2026-07-30T12:00:01Z"))).toBe(true);
		expect(pairCodeExpired("not-a-timestamp", Date.parse(deadline))).toBe(true);
	});

	test("keeps unavailable providers out of direct Agent linking", () => {
		expect(channelProviderLinkingReady("telegram")).toBe(true);
		expect(channelProviderLinkingReady("discord")).toBe(true);
		expect(channelProviderLinkingReady("whatsapp")).toBe(false);
	});

	test("describes the single-account runtime capability for both hosted runtimes", () => {
		for (const agentType of ["openclaw", "hermes"]) {
			expect(agentProviderHasSingleLinkLimit(agentType, "telegram")).toBe(true);
			expect(agentProviderHasSingleLinkLimit(agentType, "discord")).toBe(true);
		}
		expect(agentProviderHasSingleLinkLimit("openclaw", "whatsapp")).toBe(false);
		expect(agentProviderHasSingleLinkLimit("codex", "telegram")).toBe(false);
	});
});
