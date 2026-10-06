import { expect, test } from "bun:test";
import { mobileLinkDestination } from "@/platform/incoming-link";

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
	"/projects",
	"/projects/project-id",
	"/skills",
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
	"/channels/channel-id",
	"/ai-providers",
	"/deploy",
	"/terminal/agent-id",
	`/share/${"a".repeat(43)}`,
	"/sign-in",
	"/sign-up",
	"/settings/api-keys",
	"/settings/account/profile",
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
});
test("resource links reject unverified hosts and unsupported or malformed routes", () => {
	for (const path of [
		"https://evil.test/agents/id",
		"http://links.example.test/agents/id",
		"clawdi://agents/id/unknown",
		"clawdi://agents/id/project-access/p/unknown",
		"clawdi://skills/%",
		"clawdi://skills/%5C",
		"//evil.test/agents/id",
		"clawdi://share/invalid",
	]) {
		expect(mobileLinkDestination(path, ["links.example.test"], () => "")).toBe("/open-share");
	}
});
