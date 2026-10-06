"use client";

import type { AgentProfile } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import type { ReactNode } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentOverviewSectionHeading } from "@/components/dashboard/agent-overview-layout";
import { EntityRow } from "@/components/entity-card";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	AGENT_PROFILE_SEARCH_KEY,
	agentProfileName,
	agentProfilesQueryOptions,
	hasMultipleProfiles,
	profileLabel,
	sortAgentProfiles,
} from "@/lib/agent-profiles";
import { agentSectionLink } from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";
import { formatNumber, relativeTime } from "@/lib/utils";

export function useAgentProfiles(agentId: string, { enabled }: { enabled: boolean }) {
	const $api = useOpenApi();
	return useQuery({ ...agentProfilesQueryOptions($api, agentId), enabled });
}

/**
 * Overview list of an Agent's profiles. Renders nothing for single-profile
 * Agents so they keep today's layout.
 */
export function AgentProfilesOverview({
	agentId,
	agentName,
	agentType,
	profiles,
	linkSessions,
}: {
	agentId: string;
	agentName: string;
	agentType: string | null | undefined;
	profiles: readonly AgentProfile[] | undefined;
	/** Link each row to the Sessions tab filtered to that profile. */
	linkSessions: boolean;
}) {
	if (!hasMultipleProfiles(profiles)) return null;
	return (
		<section aria-labelledby="agent-profiles-heading" className="flex flex-col gap-3">
			<AgentOverviewSectionHeading>
				<h2 id="agent-profiles-heading" className="text-sm font-semibold">
					Profiles
				</h2>
			</AgentOverviewSectionHeading>
			<ul className="grid gap-3 @2xl/main:grid-cols-2" data-testid="agent-profile-list">
				{sortAgentProfiles(profiles).map((profile) => {
					const name = agentProfileName(agentName, profile);
					const status = profile.online ? "Online" : "Offline";
					return (
						<li key={profile.id} className="min-w-0" data-testid="agent-profile-row">
							<EntityRow
								icon={<AgentIcon agent={agentType} size="lg" />}
								title={name}
								meta={[
									`${formatNumber(profile.session_count)} ${profile.session_count === 1 ? "session" : "sessions"}`,
									profile.state === "removed" && profile.removed_at
										? `Removed ${relativeTime(profile.removed_at)}`
										: profile.online
											? null
											: `Last seen ${relativeTime(profile.last_seen_at)}`,
								]}
								status={
									<StatusBadge status={profile.online ? "success" : "neutral"} withDot>
										{status}
									</StatusBadge>
								}
								link={
									linkSessions
										? agentSectionLink(agentId, "sessions", {
												[AGENT_PROFILE_SEARCH_KEY]: profile.id,
											})
										: undefined
								}
								ariaLabel={`View sessions for ${name}, ${status.toLowerCase()}`}
							/>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * URL-backed profile filter for an Agent's session list. `profileKey` is
 * undefined for "all profiles"; `pending` is true while a deep-linked profile
 * is still being resolved, so callers can avoid flashing the unfiltered list.
 */
export function useAgentSessionProfileFilter({
	agentName,
	profiles,
	profilesLoading,
}: {
	agentName: string;
	profiles: readonly AgentProfile[] | undefined;
	profilesLoading: boolean;
}): { profileKey: string | undefined; pending: boolean; filter: ReactNode } {
	const [selectedId, setSelectedId] = useQueryState(
		AGENT_PROFILE_SEARCH_KEY,
		parseAsString.withOptions({ clearOnDefault: true, history: "replace" }),
	);
	if (!hasMultipleProfiles(profiles)) {
		return { profileKey: undefined, pending: Boolean(selectedId) && profilesLoading, filter: null };
	}
	const selected = selectedId ? profiles.find((profile) => profile.id === selectedId) : undefined;
	return {
		profileKey: selected?.profile_key,
		pending: false,
		filter: (
			<DataTableFacetedFilter
				title="Profile"
				// The page already names the Agent; options use the profile name alone.
				options={sortAgentProfiles(profiles).map((profile) => ({
					label: profileLabel(profile) ?? agentName,
					value: profile.id,
				}))}
				selected={selected ? [selected.id] : []}
				onChange={(ids) => {
					void setSelectedId(ids[0] ?? null);
				}}
			/>
		),
	};
}
