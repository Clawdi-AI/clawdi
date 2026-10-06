import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@clawdi/shared/api";
import {
	agentProfileName,
	hasMultipleProfiles,
	sessionProfileLabel,
	sortAgentProfiles,
} from "@/lib/agent-profiles";

function profile(overrides: Partial<AgentProfile>): AgentProfile {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		profile_key: "",
		upstream_key: "default",
		is_default: true,
		display_name: null,
		state: "active",
		online: true,
		first_seen_at: "2026-10-01T00:00:00Z",
		last_seen_at: "2026-10-06T00:00:00Z",
		removed_at: null,
		session_count: 0,
		...overrides,
	};
}

describe("agent profile naming", () => {
	test("shows the default profile as the Agent name alone", () => {
		expect(agentProfileName("Hermes", profile({}))).toBe("Hermes");
	});

	test("names other profiles 'Agent · profile', preferring the display name", () => {
		const work = profile({ is_default: false, profile_key: "work", upstream_key: "work" });
		expect(agentProfileName("Hermes", work)).toBe("Hermes · work");
		expect(agentProfileName("Hermes", { ...work, display_name: "Work" })).toBe("Hermes · Work");
	});

	test("labels only non-default session profiles", () => {
		expect(sessionProfileLabel({ profile_key: "" })).toBeNull();
		expect(sessionProfileLabel({ profile_key: "work", profile_display_name: null })).toBe("work");
		expect(sessionProfileLabel({ profile_key: "work", profile_display_name: "Work" })).toBe("Work");
	});

	test("treats a lone default profile as a single-profile Agent", () => {
		expect(hasMultipleProfiles(undefined)).toBe(false);
		expect(hasMultipleProfiles([profile({})])).toBe(false);
		expect(
			hasMultipleProfiles([profile({}), profile({ is_default: false, profile_key: "work" })]),
		).toBe(true);
	});
});

describe("sortAgentProfiles", () => {
	test("keeps the default first and moves removed profiles last", () => {
		const sorted = sortAgentProfiles([
			profile({ is_default: false, profile_key: "old", state: "removed" }),
			profile({ is_default: false, profile_key: "work" }),
			profile({}),
		]);
		expect(sorted.map((item) => item.profile_key)).toEqual(["", "work", "old"]);
	});
});
