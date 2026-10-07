import type { AgentProfile } from "../api/schemas";
import { formatNumber } from "./utils";

/** Web copy for Agent profiles (apps/web/src/components/dashboard/agent-profiles.tsx). */
export const AGENT_PROFILES_COPY = {
	title: "Profiles",
	filterTitle: "Profile",
	removed: "Removed",
	profileSessionsEmpty: "No sessions synced from this profile yet.",
} as const;

/** URL search key for the Agent sessions profile filter. Holds the profile id
 * because the default profile's wire key is the empty string. */
export const AGENT_PROFILE_SEARCH_KEY = "profile";

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

/** Overview row meta: "3 sessions". */
export function agentProfileSessionCount(count: number): string {
	return `${formatNumber(count)} ${count === 1 ? "session" : "sessions"}`;
}

/** Overview row accessible name: "View sessions for Agent · work, removed". */
export function agentProfileRowLabel(name: string, profile: Pick<AgentProfile, "state">): string {
	return `View sessions for ${name}${profile.state === "removed" ? ", removed" : ""}`;
}

/** Session filter option inside an Agent page, which already names the Agent: "work (removed)". */
export function agentProfileFilterLabel(
	agentName: string,
	profile: Pick<AgentProfile, "profile_key" | "state">,
): string {
	const label = profileLabel(profile) ?? agentName;
	return profile.state === "removed" ? `${label} (removed)` : label;
}
