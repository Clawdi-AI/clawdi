"use client";

import { AGENT_PROFILES_PATH, type AgentProfile } from "@clawdi/shared/api";
import {
	AGENT_PROFILE_SEARCH_KEY,
	agentProfileName,
	formatNumber,
	hasMultipleProfiles,
	profileLabel,
	sortAgentProfiles,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import { type ReactNode, useEffect } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentOverviewSectionHeading } from "@/components/dashboard/agent-overview-layout";
import { EntityRow } from "@/components/entity-card";
import { DataTableFacetedFilter } from "@/components/ui/data-table-faceted-filter";
import { StatusBadge } from "@/components/ui/status-badge";
import { agentSectionLink } from "@/lib/agent-routes";
import { useOpenApi } from "@/lib/api";

export function useAgentProfiles(agentId: string, { enabled }: { enabled: boolean }) {
	const $api = useOpenApi();
	return useQuery({
		...$api.queryOptions("get", AGENT_PROFILES_PATH, {
			params: { path: { agent_id: agentId } },
		}),
		enabled,
	});
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
					const removed = profile.state === "removed";
					return (
						<li key={profile.id} className="min-w-0" data-testid="agent-profile-row">
							<EntityRow
								icon={<AgentIcon agent={agentType} size="lg" />}
								title={name}
								meta={`${formatNumber(profile.session_count)} ${profile.session_count === 1 ? "session" : "sessions"}`}
								// Liveness belongs to the Agent; a profile is only active or removed.
								status={removed ? <StatusBadge>Removed</StatusBadge> : undefined}
								link={
									linkSessions
										? agentSectionLink(agentId, "sessions", {
												[AGENT_PROFILE_SEARCH_KEY]: profile.id,
											})
										: undefined
								}
								ariaLabel={`View sessions for ${name}${removed ? ", removed" : ""}`}
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
 * `onProfileChange` runs in the same update as the selection so callers can
 * reset dependent state (such as the page) without an extra render.
 */
export function useAgentSessionProfileFilter({
	agentName,
	profiles,
	profilesLoading,
	onProfileChange,
}: {
	agentName: string;
	profiles: readonly AgentProfile[] | undefined;
	profilesLoading: boolean;
	onProfileChange?: () => void;
}): { profileKey: string | undefined; pending: boolean; filter: ReactNode } {
	const [selectedId, setSelectedId] = useQueryState(
		AGENT_PROFILE_SEARCH_KEY,
		parseAsString.withOptions({ clearOnDefault: true, history: "replace" }),
	);
	// A stale or mistyped `?profile=` id is dropped once the list confirms it is unknown.
	const unknownSelection =
		Boolean(selectedId) &&
		profiles !== undefined &&
		!profiles.some((profile) => profile.id === selectedId);
	useEffect(() => {
		if (unknownSelection) void setSelectedId(null);
	}, [unknownSelection, setSelectedId]);

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
				options={sortAgentProfiles(profiles).map((profile) => {
					const label = profileLabel(profile) ?? agentName;
					return {
						label: profile.state === "removed" ? `${label} (removed)` : label,
						value: profile.id,
					};
				})}
				selected={selected ? [selected.id] : []}
				onChange={(ids) => {
					void setSelectedId(ids[0] ?? null);
					onProfileChange?.();
				}}
			/>
		),
	};
}
