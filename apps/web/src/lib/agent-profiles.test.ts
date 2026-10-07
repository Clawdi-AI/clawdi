import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@clawdi/shared/api";
import {
	agentProfileName,
	hasMultipleProfiles,
	profileLabel,
	sortAgentProfiles,
} from "@/lib/agent-profiles";

function profile(overrides: Partial<AgentProfile>): AgentProfile {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		profile_key: "",
		is_default: true,
		state: "active",
		session_count: 0,
		...overrides,
	};
}

describe("agent profile naming", () => {
	test("shows the default profile as the Agent name alone", () => {
		expect(agentProfileName("Hermes", profile({}))).toBe("Hermes");
	});

	test("names other profiles 'Agent · profile_key'", () => {
		const work = profile({ is_default: false, profile_key: "work" });
		expect(agentProfileName("Hermes", work)).toBe("Hermes · work");
	});

	test("labels only non-default session profiles", () => {
		expect(profileLabel({ profile_key: "" })).toBeNull();
		expect(profileLabel({ profile_key: null })).toBeNull();
		expect(profileLabel({ profile_key: "work" })).toBe("work");
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
