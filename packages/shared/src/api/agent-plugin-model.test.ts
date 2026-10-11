import { expect, test } from "bun:test";
import { type AgentPluginDesiredState, agentPluginRefetchInterval } from "./agent-plugin-model";

function plugin(
	convergence: AgentPluginDesiredState["convergence"],
	updatedAt: string,
): AgentPluginDesiredState {
	return {
		installation_id: "installation-id",
		agent_id: "agent-id",
		plugin_name: "plugin-name",
		version: "1.0.0",
		catalog_revision: "revision",
		desired_state: "present",
		convergence,
		created_at: updatedAt,
		updated_at: updatedAt,
	};
}

test("install polling continues beyond two minutes, slows when stalled, and stops when settled", () => {
	const now = new Date("2026-10-11T12:00:00Z");
	const active = plugin("not_observed", "2026-10-11T11:57:00Z");
	const stalled = plugin("not_observed", "2026-10-11T11:00:00Z");
	const installed = plugin("installed", "2026-10-11T11:00:00Z");
	const failed = plugin("failed", "2026-10-11T11:00:00Z");
	for (const [plugins, expected] of [
		[undefined, false],
		[[], false],
		[[active], 5_000],
		[[stalled], 60_000],
		[[stalled, active], 5_000],
		[[installed, failed], false],
		[[stalled, installed], 60_000],
	] satisfies [AgentPluginDesiredState[] | undefined, number | false][]) {
		expect(agentPluginRefetchInterval(plugins, now)).toBe(expected);
	}
	expect(agentPluginRefetchInterval([active], new Date("2026-10-12T12:00:00Z"))).toBe(60_000);
});
