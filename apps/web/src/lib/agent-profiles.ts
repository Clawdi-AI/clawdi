import type { AgentProfile } from "@clawdi/shared/api";
import type { OpenApiClient } from "@/lib/api";

/** URL search key for the Agent sessions profile filter. Holds the profile id
 * because the default profile's wire key is the empty string. */
export const AGENT_PROFILE_SEARCH_KEY = "profile";

export function agentProfilesQueryOptions(api: OpenApiClient, agentId: string) {
	return api.queryOptions("get", "/v1/agents/{agent_id}/profiles", {
		params: { path: { agent_id: agentId } },
	});
}

/** Profiles only add UI once an Agent has more than its default profile. */
export function hasMultipleProfiles(
	profiles: readonly AgentProfile[] | null | undefined,
): profiles is readonly AgentProfile[] {
	return (profiles?.length ?? 0) > 1;
}

/** Default (`""`) first, then active profiles, then removed ones; API order within each group. */
export function sortAgentProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
	const rank = (profile: AgentProfile) =>
		profile.profile_key === "" ? 0 : profile.state === "removed" ? 2 : 1;
	return [...profiles].sort((a, b) => rank(a) - rank(b));
}

/** Profile-only label for a profile or session; null for the default profile. */
export function profileLabel(item: { profile_key?: string | null }): string | null {
	return item.profile_key || null;
}

/** "Agent · work"; the default profile is shown as the Agent name alone. */
export function agentProfileName(
	agentName: string,
	profile: Pick<AgentProfile, "profile_key">,
): string {
	const label = profileLabel(profile);
	return label ? `${agentName} · ${label}` : agentName;
}
