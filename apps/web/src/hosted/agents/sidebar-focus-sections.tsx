"use client";

import {
	AgentFocusLoadingSections,
	AgentSectionList,
	CONNECTED_AGENT_SECTIONS,
	HOSTED_AGENT_SECTIONS,
} from "@/components/app-sidebar";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import type { AgentSectionId } from "@/lib/agent-routes";

/**
 * Sidebar focus nav for hosted-managed environments. Mirrors `AgentHome`'s
 * routing decision: an env backed by a Cloud deploy-API deployment gets the
 * hosted section set (console / terminal / ai / channels); a hosted_managed
 * env with no deployment — a legacy v1 agent — navigates like any connected
 * agent. Sharing the `useAgentDeployment` join (and its TanStack cache) keeps
 * the sidebar and the detail page from disagreeing about which surface an
 * agent gets.
 */
export function HostedAgentFocusSections({
	agentId,
	activeSection,
	onNavigate,
}: {
	agentId: string;
	activeSection: AgentSectionId;
	onNavigate?: () => void;
}) {
	const { deployment, isLoading } = useAgentDeployment(agentId);
	// `display: contents` keeps the OSS-clean DOM marker without inserting a
	// box between the sidebar and its section groups (their spacing relies on
	// being direct children).
	if (isLoading) {
		return (
			<div data-hosted="true" className="contents">
				<AgentFocusLoadingSections
					agentId={agentId}
					activeSection={activeSection}
					onNavigate={onNavigate}
				/>
			</div>
		);
	}
	return (
		<div data-hosted="true" className="contents">
			<AgentSectionList
				agentId={agentId}
				sections={deployment ? HOSTED_AGENT_SECTIONS : CONNECTED_AGENT_SECTIONS}
				activeSection={activeSection}
				onNavigate={onNavigate}
			/>
		</div>
	);
}
