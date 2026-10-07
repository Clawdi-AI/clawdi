import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../api/schemas";
import {
	agentProfileFilterLabel,
	agentProfileName,
	agentSessionProfileSelection,
	hasMultipleProfiles,
	profileLabel,
	sortAgentProfiles,
} from "./agent-profiles";

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

	test("names filter options by profile, falling back to the Agent for the default", () => {
		expect(agentProfileFilterLabel("Hermes", profile({}))).toBe("Hermes");
		expect(
			agentProfileFilterLabel("Hermes", profile({ profile_key: "old", state: "removed" })),
		).toBe("old (removed)");
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

describe("agentSessionProfileSelection", () => {
	const work = profile({
		id: "00000000-0000-4000-8000-000000000002",
		is_default: false,
		profile_key: "work",
	});
	const profiles = [profile({}), work];

	test("selects a known profile and filters by its key", () => {
		const result = agentSessionProfileSelection({
			selectedId: work.id,
			profiles,
			profilesLoading: false,
		});
		expect(result).toEqual({ unknown: false, pending: false, selected: work });
	});

	test("flags an id the loaded list does not contain so the URL drops it", () => {
		const result = agentSessionProfileSelection({
			selectedId: "stale",
			profiles,
			profilesLoading: false,
		});
		expect(result).toEqual({ unknown: true, pending: false, selected: undefined });
	});

	test("holds a deep-linked id while profiles load, and only then", () => {
		expect(
			agentSessionProfileSelection({
				selectedId: work.id,
				profiles: undefined,
				profilesLoading: true,
			}).pending,
		).toBe(true);
		expect(
			agentSessionProfileSelection({
				selectedId: undefined,
				profiles: undefined,
				profilesLoading: true,
			}).pending,
		).toBe(false);
		// A failed list neither blocks the sessions nor discards the URL.
		expect(
			agentSessionProfileSelection({
				selectedId: work.id,
				profiles: undefined,
				profilesLoading: false,
			}),
		).toEqual({ unknown: false, pending: false, selected: undefined });
	});

	test("ignores the selection for single-profile Agents", () => {
		const only = profile({});
		expect(
			agentSessionProfileSelection({
				selectedId: only.id,
				profiles: [only],
				profilesLoading: false,
			}),
		).toEqual({ unknown: false, pending: false, selected: undefined });
	});
});
