import { describe, expect, test } from "bun:test";
import {
	agentDisplayName,
	agentTextLabel,
	cleanMachineName,
	compareAgentEnvironments,
} from "@/components/dashboard/agent-label";

describe("cleanMachineName", () => {
	test("strips local network suffixes", () => {
		expect(cleanMachineName("devbook.local")).toBe("devbook");
		expect(cleanMachineName("lab.lan")).toBe("lab");
	});

	test("keeps machine names intact for lower-level cleaning", () => {
		expect(cleanMachineName("v2-hosted-a1b2c3d4")).toBe("v2-hosted-a1b2c3d4");
	});
});

describe("agentDisplayName", () => {
	test("uses the registered machine name as the default Cloud agent name", () => {
		expect(
			agentDisplayName(
				{
					machine_name: "Shared Hosted Compute",
					agent_type: "openclaw",
				},
				{ ownershipKind: "cloud" },
			),
		).toBe("Shared Hosted Compute");
	});

	test("uses machine name as the default connected agent name", () => {
		expect(agentDisplayName({ machine_name: "Jing-Mac.local", agent_type: "codex" })).toBe(
			"Jing-Mac",
		);
	});

	test("uses the registered machine name as the default Legacy agent name", () => {
		expect(
			agentDisplayName(
				{
					machine_name: "v1-hosted-runtime",
					agent_type: "hermes",
				},
				{ ownershipKind: "legacy" },
			),
		).toBe("v1-hosted-runtime");
	});

	test("prefers user display name for every source", () => {
		expect(
			agentDisplayName(
				{
					display_name: "Launch runner",
					machine_name: "Shared Hosted Compute",
					agent_type: "hermes",
				},
				{ ownershipKind: "legacy" },
			),
		).toBe("Launch runner");
	});

	test("keeps runtime as a secondary label when the primary name is not the runtime", () => {
		expect(
			agentTextLabel(
				{
					machine_name: "Research Agent",
					agent_type: "codex",
				},
				{ ownershipKind: "cloud" },
			),
		).toBe("Cloud · Research Agent · Codex");
	});
});

describe("compareAgentEnvironments", () => {
	test("uses persisted sort order before name or runtime", () => {
		const first = {
			id: "agent-a",
			machine_name: "Zed",
			agent_type: "codex",
			sort_order: 1,
		};
		const second = {
			id: "agent-b",
			machine_name: "Alpha",
			agent_type: "openclaw",
			sort_order: 0,
		};

		expect([first, second].sort(compareAgentEnvironments).map((agent) => agent.id)).toEqual([
			"agent-b",
			"agent-a",
		]);
	});

	test("falls back to display name and id for stable ordering", () => {
		const agents = [
			{ id: "c", machine_name: "beta", agent_type: "codex", sort_order: null },
			{ id: "a", display_name: "Alpha", machine_name: "zed", agent_type: "codex" },
			{ id: "b", display_name: "Alpha", machine_name: "zed", agent_type: "codex" },
		];

		expect(agents.sort(compareAgentEnvironments).map((agent) => agent.id)).toEqual(["a", "b", "c"]);
	});
});
