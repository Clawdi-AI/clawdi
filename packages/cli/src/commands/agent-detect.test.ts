import { describe, expect, test } from "bun:test";
import type { DesktopAgentType } from "@clawdi/shared/desktop";
import { detectLocalAgents } from "./agent-detect";

function entry(
	type: DesktopAgentType,
	detect: () => Promise<boolean>,
	getVersion: () => Promise<string | null> = async () => null,
) {
	return {
		agentType: type,
		displayName: type,
		create: () => ({ detect, getVersion }),
	};
}

describe("desktop agent detection", () => {
	test("reports usable, absent, and unreadable adapters without aborting the scan", async () => {
		const agents = await detectLocalAgents(
			[
				entry(
					"claude_code",
					async () => true,
					async () => "1.2.3",
				),
				entry("codex", async () => false),
				entry("openclaw", async () => {
					throw new Error("private path");
				}),
			],
			new Set(["claude_code"]),
		);

		expect(agents).toEqual([
			{
				type: "claude_code",
				displayName: "claude_code",
				detected: true,
				registered: true,
				version: "1.2.3",
				inspection: "complete",
			},
			{
				type: "codex",
				displayName: "codex",
				detected: false,
				registered: false,
				version: null,
				inspection: "complete",
			},
			{
				type: "openclaw",
				displayName: "openclaw",
				detected: false,
				registered: false,
				version: null,
				inspection: "failed",
			},
		]);
	});
});
