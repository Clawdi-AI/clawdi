import { describe, expect, test } from "bun:test";
import { agentDisplayName } from "@/components/dashboard/agent-label";
import { sessionAgentIdentityInput } from "@/components/sessions/session-agent-label";

describe("sessionAgentIdentityInput", () => {
	test("preserves canonical agent identity fields from session payloads", () => {
		const identity = sessionAgentIdentityInput({
			agent_name: "Launch runner",
			agent_display_name: "Launch runner",
			agent_default_name: "Research Agent",
			machine_name: "Shared Hosted Compute",
			agent_type: "codex",
		});

		expect(agentDisplayName(identity)).toBe("Launch runner");
	});

	test("falls back through default name before machine metadata", () => {
		const identity = sessionAgentIdentityInput({
			agent_name: "Research Agent",
			agent_default_name: "Research Agent",
			machine_name: "Shared Hosted Compute",
			agent_type: "codex",
		});

		expect(agentDisplayName(identity)).toBe("Research Agent");
	});

	test("falls back to the friendly runtime label when only agent type is present", () => {
		const identity = sessionAgentIdentityInput({
			agent_type: "claude-code",
		});

		expect(agentDisplayName(identity)).toBe("Claude Code");
	});
});
