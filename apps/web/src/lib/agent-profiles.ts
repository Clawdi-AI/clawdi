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

/** Default first, then active profiles, then removed ones; API order within each group. */
export function sortAgentProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
	const rank = (profile: AgentProfile) =>
		profile.is_default ? 0 : profile.state === "removed" ? 2 : 1;
	return [...profiles].sort((a, b) => rank(a) - rank(b));
}

/** Profile-only label; null for the default profile. */
export function profileLabel(
	profile: Pick<AgentProfile, "is_default" | "display_name" | "upstream_key" | "profile_key">,
): string | null {
	if (profile.is_default) return null;
	return profile.display_name?.trim() || profile.upstream_key || profile.profile_key;
}

/** "Agent · work"; the default profile is shown as the Agent name alone. */
export function agentProfileName(
	agentName: string,
	profile: Pick<AgentProfile, "is_default" | "display_name" | "upstream_key" | "profile_key">,
): string {
	const label = profileLabel(profile);
	return label ? `${agentName} · ${label}` : agentName;
}

/** Session rows carry the profile key; the default profile (`""`) has no label. */
export function sessionProfileLabel(session: {
	profile_key?: string | null;
	profile_display_name?: string | null;
}): string | null {
	if (!session.profile_key) return null;
	return session.profile_display_name?.trim() || session.profile_key;
}
