import { useLocalSearchParams, useSegments } from "expo-router";
import { AgentResourceRouteGate } from "@/components/dashboard/agent-resource-route-gate";
import { LibraryPage } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { projectRouteFilter, routeParam } from "@/lib/route-params";
import { SkillEditorScreen } from "@/pages/dashboard/skills/[key]/page";
import { VaultDetailScreen } from "@/pages/dashboard/vault/[slug]/page";

export default function AgentResourceDetailPage() {
	const params = useLocalSearchParams<{
		id?: string | string[];
		project?: string | string[];
		projectId?: string | string[];
	}>();
	const segments = useSegments();
	const filter = projectRouteFilter(params.project ?? params.projectId);
	if (filter.kind === "invalid")
		return (
			<LibraryPage>
				<EmptyState title="Project unavailable" />
			</LibraryPage>
		);
	return (
		<AgentResourceRouteGate
			agentId={routeParam(params.id)}
			projectId={filter.kind === "project" ? filter.id : undefined}
			workspaceFallback
		>
			{(projectId) =>
				segments.some((segment) => segment === "vaults") ? (
					<VaultDetailScreen projectId={projectId} />
				) : (
					<SkillEditorScreen projectId={projectId} />
				)
			}
		</AgentResourceRouteGate>
	);
}
