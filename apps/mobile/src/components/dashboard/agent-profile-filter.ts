import type { AgentProfile } from "@clawdi/shared/api";
import {
	AGENT_PROFILE_SEARCH_KEY,
	AGENT_PROFILES_COPY,
	agentProfileFilterOptions,
	hasMultipleProfiles,
} from "@clawdi/shared/view";
import type { HeaderMenuSection } from "@/platform/navigation/native-header-types";

/**
 * Profile filter as an inline header-menu section. The page already names the
 * Agent, so options use the profile name alone; the default profile falls back
 * to the Agent name, which must be known before the section is offered.
 */
export function agentProfileMenuSection({
	agentName,
	profiles,
	selectedId,
	allLabel,
	onSelect,
}: {
	agentName: string | undefined;
	profiles: readonly AgentProfile[] | undefined;
	selectedId: string | undefined;
	allLabel: string;
	onSelect: (profileId: string | undefined) => void;
}): HeaderMenuSection | null {
	if (!agentName || !hasMultipleProfiles(profiles)) return null;
	return {
		id: AGENT_PROFILE_SEARCH_KEY,
		title: AGENT_PROFILES_COPY.filterTitle,
		items: [
			{
				id: "profile-all",
				label: allLabel,
				selected: !selectedId,
				onPress: () => onSelect(undefined),
			},
			...agentProfileFilterOptions(agentName, profiles).map((option) => ({
				id: `profile-${option.id}`,
				label: option.label,
				selected: option.id === selectedId,
				onPress: () => onSelect(option.id),
			})),
		],
	};
}
