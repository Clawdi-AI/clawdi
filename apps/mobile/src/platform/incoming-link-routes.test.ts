import { expect, test } from "bun:test";
import { agentFilePaths } from "@clawdi/shared/linking";
import {
	mobileBrowserLink,
	mobileLinkDestination,
	routeMobileIncomingLink,
} from "@/platform/incoming-link";

const paths = [
	"/",
	"/agents",
	"/agents/agent-id",
	"/agents/agent-id/sessions",
	"/agents/agent-id/sessions/session-id",
	"/agents/agent-id/memories/memory-id",
	"/agents/agent-id/connectors/github",
	"/agents/agent-id/plugins/github",
	"/agents/agent-id/project-access/project-id",
	"/agents/agent-id/project-access/project-id/skills",
	"/agents/agent-id/project-access/project-id/vaults",
	"/agents/agent-id/vaults/acme-prod",
	"/agents/agent-id/skills/owner/repository/skill?project=project-id",
	"/agents/agent-id/model-provider",
	"/agents/agent-id/channel-links",
	"/agents/agent-id/console",
	"/agents/agent-id/files",
	"/agents/agent-id/terminal",
	"/sessions",
	"/sessions/session-id",
	"/sessions/shared",
	"/sessions/session-id/sharing",
	"/projects/new",
	"/projects/join",
	"/projects/project-id/edit",
	"/projects/project-id/agents",
	"/projects/project-id/vaults/new",
	"/memories/new",
	"/memories/memory-id/edit",
	"/vault/new",
	"/vault/add-keys",
	"/vault/acme-prod/add-keys",
	"/vault/acme-prod/transfer",
	"/vault/acme-prod/split",
	"/vault/acme-prod/requests",
	"/connectors/stripe/connect",
	"/connectors/github/accounts/account-id/rename",
	"/projects",
	"/projects/invitations",
	"/projects/project-id/sharing",
	"/projects/project-id",
	"/skills",
	"/skills/new",
	"/skills/archive",
	"/skills/owner%2Frepository%2Fskill/archive",
	"/skills/owner%2Frepository%2Fskill",
	"/memories",
	"/memories/memory-id",
	"/vault",
	"/vault/acme-prod",
	"/vaults",
	"/vaults/acme-prod",
	"/connectors",
	"/connectors/github",
	"/channels",
	"/channels/whatsapp",
	"/channels/channel-id",
	"/channels/channel-id/link",
	"/channels/channel-id/chats?linkId=link-id",
	"/channels/channel-id/pair?linkId=link-id",
	"/ai-providers",
	"/ai-providers/new",
	"/ai-providers/provider-id/edit",
	"/ai-providers/provider-id/remove",
	"/ai-providers/provider-id/oauth",
	"/deploy",
	"/terminal/agent-id",
	`/share/${"a".repeat(43)}`,
	"/sign-in",
	"/sign-up",
	"/settings/api-keys",
	"/settings/account",
];
test("Web paths resolve identically for custom scheme and verified universal links", () => {
	for (const path of paths) {
		const stage = () => {
			throw new Error("Resource links must not stage capabilities");
		};
		expect(mobileLinkDestination(`clawdi://${path.slice(1)}`, [], stage)).toBe(path);
		expect(
			mobileLinkDestination(`https://links.example.test${path}`, ["links.example.test"], stage),
		).toBe(path);
		expect(mobileLinkDestination(path, [], stage)).toBe(path);
	}
	expect(
		mobileLinkDestination(
			"https://links.example.test/?settings=wallet",
			["links.example.test"],
			() => "",
		),
	).toBe("/settings/wallet");
	for (const page of ["/agents/agent-id", "/sessions", "/skills/key"]) {
		expect(mobileLinkDestination(`clawdi://${page.slice(1)}?settings=wallet`, [], () => "")).toBe(
			"/settings/wallet",
		);
	}
});
test("resource links reject unverified hosts and unsupported or malformed routes", () => {
	for (const path of [
		"https://evil.test/agents/id",
		"http://links.example.test/agents/id",
		"clawdi://agents/id/unknown",
		"clawdi://agents/id/project-access/p/unknown",
		"clawdi://skills/%",
		"clawdi://skills/key/unknown",
		"clawdi://projects/id/unknown",
		"clawdi://native/projects/invitations",
		"clawdi://skills/%5C",
		"//evil.test/agents/id",
		"clawdi://share/invalid",
		"clawdi://ai-providers/provider-id/unknown",
		"clawdi://channels/channel-id/unknown",
		"clawdi://dev/account?panel=profile",
		"https://links.example.test/skill.md",
		"https://links.example.test/skills/clawdi/SKILL.md",
		"https://links.example.test/skills/owner/repository/SKILL.md",
		"https://links.example.test/skills/%53KILL.md/SKILL.md",
		"https://links.example.test/skills.md",
		"https://links.example.test/silly",
		"https://links.example.test/sign-in-extra",
		"https://links.example.test/vault-request-extra",
		"https://links.example.test/vaults-extra",
		"https://links.example.test/shareholder",
	]) {
		expect(mobileLinkDestination(path, ["links.example.test"], () => "")).toBe("/open-share");
	}
});

test("machine-readable HTTPS links open once in the browser without native navigation or capability intake", async () => {
	const hosts = ["links.example.test"];
	const stage = () => {
		throw new Error("Browser links must not stage capabilities");
	};
	for (const path of [
		...Object.values(agentFilePaths),
		"/skills/another/SKILL.md",
		"/skills/owner/repository/SKILL.md",
		"/skills/clawdi/%53KILL.md",
	]) {
		for (const initial of [false, true]) {
			const opened: string[] = [];
			const link = `https://links.example.test${path}?format=raw`;
			expect(
				await routeMobileIncomingLink(
					link,
					hosts,
					stage,
					async (url) => {
						opened.push(url);
					},
					initial,
				),
			).toBe(initial ? "/" : null);
			expect(opened).toEqual([link]);
		}
	}
	for (const path of ["/sign-in", "/vaults/example", "/skills/owner%2Frepository%2Fskill"]) {
		expect(
			await routeMobileIncomingLink(
				`https://links.example.test${path}`,
				hosts,
				stage,
				async () => {
					throw new Error("Native resources must not open the browser");
				},
				false,
			),
		).toBe(path);
	}
});

test("browser fallback rejects unverified or malformed URLs and handles launch failure", async () => {
	const hosts = ["links.example.test"];
	const stage = () => {
		throw new Error("Invalid links must not stage capabilities");
	};
	for (const path of [
		"https://evil.test/skills/clawdi/SKILL.md",
		"http://links.example.test/skills/clawdi/SKILL.md",
		"https://user@links.example.test/skills/clawdi/SKILL.md",
		"https://links.example.test:444/skills/clawdi/SKILL.md",
		"https://links.example.test/skills/%/SKILL.md",
		"https://links.example.test/skills/\\clawdi/SKILL.md",
		"https://links.example.test/skills/clawdi/SKILL.md\n",
		"clawdi://skills/clawdi/SKILL.md",
		"/skills/clawdi/SKILL.md",
	]) {
		const opened: string[] = [];
		expect(mobileBrowserLink(path, hosts)).toBeNull();
		expect(
			await routeMobileIncomingLink(
				path,
				hosts,
				stage,
				async (url) => {
					opened.push(url);
				},
				false,
			),
		).toBe("/open-share");
		expect(opened).toEqual([]);
	}
	const link = "https://links.example.test/skills/clawdi/SKILL.md";
	expect(mobileBrowserLink(link, [])).toBeNull();
	for (const initial of [false, true]) {
		let attempts = 0;
		expect(
			await routeMobileIncomingLink(
				link,
				hosts,
				stage,
				async () => {
					attempts++;
					throw new Error("Browser unavailable");
				},
				initial,
			),
		).toBe("/open-share");
		expect(attempts).toBe(1);
	}
});
