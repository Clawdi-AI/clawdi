import type { AgentProfile } from "@clawdi/shared/api";
import { agentProfilesClasses as styles } from "@clawdi/shared/ui";
import {
	AGENT_PROFILE_SEARCH_KEY,
	AGENT_PROFILES_COPY,
	agentProfileName,
	agentProfileRowLabel,
	agentProfileSessionCount,
	agentSessionProfileSelection,
	hasMultipleProfiles,
	sortAgentProfiles,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentOverviewHeading } from "@/components/dashboard/agent-overview-layout";
import { agentProfileMenuSection } from "@/components/dashboard/agent-profile-filter";
import { EntityRow } from "@/components/entity-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { agentSectionHref } from "@/lib/agent-routes";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import type { HeaderMenuSection } from "@/platform/navigation/native-header-types";

export function useAgentProfiles(agentId: string | undefined, { enabled }: { enabled: boolean }) {
	const { agentProfiles } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useQuery({
		queryKey: accountQueryKey(scope, "agent-profiles", agentId ?? "missing"),
		queryFn: ({ signal }) => {
			if (!agentId) throw new Error("An Agent id is required");
			return read((readSignal) => agentProfiles.listProfiles(agentId, readSignal), signal);
		},
		enabled: scope.isReady && enabled && Boolean(agentId),
		retry: false,
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
	/** Link each row to the Sessions section filtered to that profile. */
	linkSessions: boolean;
}) {
	if (!hasMultipleProfiles(profiles)) return null;
	return (
		<WebView recipe={styles.section}>
			<AgentOverviewHeading>{AGENT_PROFILES_COPY.title}</AgentOverviewHeading>
			<WebView recipe={styles.list} testID="agent-profile-list">
				{sortAgentProfiles(profiles).map((profile) => {
					const name = agentProfileName(agentName, profile);
					return (
						<WebView key={profile.id} recipe={styles.item}>
							<EntityRow
								icon={<AgentIcon agent={agentType} size="lg" />}
								title={name}
								meta={agentProfileSessionCount(profile.session_count)}
								// Liveness belongs to the Agent; a profile is only active or removed.
								status={
									profile.state === "removed" ? (
										<StatusBadge>
											<Text>{AGENT_PROFILES_COPY.removed}</Text>
										</StatusBadge>
									) : undefined
								}
								link={
									linkSessions
										? {
												to: agentSectionHref(agentId, "sessions"),
												search: { [AGENT_PROFILE_SEARCH_KEY]: profile.id },
											}
										: undefined
								}
								ariaLabel={agentProfileRowLabel(name, profile)}
							/>
						</WebView>
					);
				})}
			</WebView>
		</WebView>
	);
}

/**
 * URL-backed profile filter for an Agent's sessions, rendered as a native
 * header-menu section. `profileKey` is undefined for "all profiles"; `pending`
 * is true while a deep-linked profile is still being resolved, so callers can
 * avoid flashing the unfiltered list. `agentName` stays undefined until the
 * Agent loads, so the default profile's option is never blank.
 */
export function useAgentSessionProfileFilter({
	agentName,
	profiles,
	profilesLoading,
}: {
	agentName: string | undefined;
	profiles: readonly AgentProfile[] | undefined;
	profilesLoading: boolean;
}): {
	profileKey: string | undefined;
	pending: boolean;
	selected: AgentProfile | undefined;
	clear: () => void;
	section: HeaderMenuSection | null;
} {
	const t = useI18n();
	const params = useLocalSearchParams<{ [AGENT_PROFILE_SEARCH_KEY]?: string | string[] }>();
	const selectedId = routeParam(params[AGENT_PROFILE_SEARCH_KEY]);
	const select = (id: string | undefined) => router.setParams({ [AGENT_PROFILE_SEARCH_KEY]: id });
	const { unknown, pending, selected } = agentSessionProfileSelection({
		selectedId,
		profiles,
		profilesLoading,
	});
	// A stale or mistyped `?profile=` id is dropped once the list confirms it is unknown.
	useEffect(() => {
		if (unknown) router.setParams({ [AGENT_PROFILE_SEARCH_KEY]: undefined });
	}, [unknown]);
	return {
		profileKey: selected?.profile_key,
		pending,
		selected,
		clear: () => select(undefined),
		section: agentProfileMenuSection({
			agentName,
			profiles,
			selectedId: selected?.id,
			allLabel: t("sessionFilters.allProfiles"),
			onSelect: select,
		}),
	};
}
