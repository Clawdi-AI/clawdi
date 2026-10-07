import { describe, expect, mock, test } from "bun:test";
import type { AgentProfile } from "@clawdi/shared/api";
import { agentProfileMenuSection } from "@/components/dashboard/agent-profile-filter";

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

const work = profile({ id: "work-id", is_default: false, profile_key: "work" });
const old = profile({ id: "old-id", is_default: false, profile_key: "old", state: "removed" });
const profiles = [old, work, profile({ id: "default-id" })];

describe("agentProfileMenuSection", () => {
	test("is withheld until the Agent name is known or a second profile exists", () => {
		const base = { profiles, selectedId: undefined, allLabel: "All profiles", onSelect: () => {} };
		expect(agentProfileMenuSection({ ...base, agentName: undefined })).toBeNull();
		expect(agentProfileMenuSection({ ...base, agentName: "" })).toBeNull();
		expect(
			agentProfileMenuSection({ ...base, agentName: "Hermes", profiles: [profile({})] }),
		).toBeNull();
	});

	test("lists All, then default, active and removed profiles with one checked option", () => {
		const section = agentProfileMenuSection({
			agentName: "Hermes",
			profiles,
			selectedId: undefined,
			allLabel: "All profiles",
			onSelect: () => {},
		});
		expect(section?.title).toBe("Profile");
		expect(section?.items.map((item) => [item.label, item.selected])).toEqual([
			["All profiles", true],
			["Hermes", false],
			["work", false],
			["old (removed)", false],
		]);
	});

	test("checks the selected profile and reports picks by profile id", () => {
		const onSelect = mock((_id: string | undefined) => {});
		const section = agentProfileMenuSection({
			agentName: "Hermes",
			profiles,
			selectedId: work.id,
			allLabel: "All profiles",
			onSelect,
		});
		expect(section?.items.filter((item) => item.selected).map((item) => item.label)).toEqual([
			"work",
		]);
		section?.items.find((item) => item.label === "old (removed)")?.onPress();
		section?.items[0]?.onPress();
		expect(onSelect.mock.calls).toEqual([["old-id"], [undefined]]);
	});
});
