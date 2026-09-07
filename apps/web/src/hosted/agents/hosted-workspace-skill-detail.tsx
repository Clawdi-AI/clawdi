"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailPanel } from "@/components/detail/layout";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { workspaceSkillErrorNormalizer } from "@/hosted/agents/workspace-skill-errors";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { billingKeys } from "@/hosted/billing/query-keys";
import { agentProjectResourceHref } from "@/lib/agent-routes";
import { useDeploymentEventStreamActive } from "@/lib/deployment-event-stream-context";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";
import { stripFrontmatter } from "@/pages/dashboard/skills/[key]/page";

export default function HostedWorkspaceSkillDetail({
	agentId,
	projectId,
	skillKey,
	children,
}: {
	agentId: string;
	projectId: string;
	skillKey: string;
	children: ReactNode;
}) {
	const client = useBillingClient();
	const bindings = useAgentProjectBindings(agentId);
	const resolution = useAgentDeployment(agentId, useDeploymentEventStreamActive());
	const deploymentId = resolution.deployment?.resource.id;
	const isWorkspace = bindings.data?.some(
		(binding) => binding.project_id === projectId && binding.binding_type === "primary",
	);
	const inventory = useQuery({
		queryKey: billingKeys.workspaceSkills(deploymentId ?? ""),
		queryFn: () => {
			if (!deploymentId) throw new Error("Agent is unavailable");
			return client.listWorkspaceSkills(deploymentId);
		},
		enabled: Boolean(isWorkspace && deploymentId),
	});
	const desired = inventory.data?.items?.find((skill) => skill.skill_key === skillKey);
	const detail = useQuery({
		queryKey: [
			...billingKeys.workspaceSkills(deploymentId ?? ""),
			"detail",
			skillKey,
			desired?.source.commit,
		],
		queryFn: () => {
			if (!deploymentId) throw new Error("Agent is unavailable");
			return client.getWorkspaceSkill(deploymentId, skillKey);
		},
		enabled: Boolean(isWorkspace && deploymentId && desired),
	});
	const { copy } = useCopyToClipboard({ success: "Skill copied", error: "Couldn't copy Skill" });
	useSetBreadcrumbTitle(desired ? (detail.data?.name ?? skillKey) : null);

	if (bindings.data && !isWorkspace) return children;
	if (resolution.membershipResolved && !resolution.deployment && !resolution.error) return children;
	if (inventory.data && !desired && !inventory.error) return children;

	const error =
		(shouldBlockQueryError(bindings.error, bindings.data) ? bindings.error : null) ??
		resolution.error ??
		(shouldBlockQueryError(inventory.error, inventory.data) ? inventory.error : null) ??
		(shouldBlockQueryError(detail.error, detail.data) ? detail.error : null);
	return (
		<div
			data-hosted="true"
			className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}
		>
			<DetailBackLink
				href={agentProjectResourceHref(agentId, projectId, "skills")}
				label="Skills"
				mobileOnly={false}
			/>
			{error ? (
				<ApiErrorPanel
					error={error}
					normalizer={error === bindings.error ? undefined : workspaceSkillErrorNormalizer}
					title="Couldn't load this Skill"
					onRetry={() => {
						if (bindings.error) void bindings.refetch();
						else if (resolution.error) void resolution.refetch();
						else if (inventory.error) void inventory.refetch();
						else void detail.refetch();
					}}
				/>
			) : detail.data ? (
				<>
					<PageHeader
						title={detail.data.name}
						description={detail.data.description}
						actions={
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									if (detail.data) void copy(detail.data.content);
								}}
							>
								<Copy className="size-3.5" /> Copy skill
							</Button>
						}
					/>
					<a
						href={`${detail.data.source.url}/tree/${detail.data.source.commit}/${detail.data.source.path.split("/").map(encodeURIComponent).join("/")}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
					>
						<ExternalLink className="size-3.5" /> View source on GitHub
					</a>
					<DetailPanel>
						<Markdown content={stripFrontmatter(detail.data.content)} />
					</DetailPanel>
				</>
			) : (
				<Skeleton className="h-40 rounded-lg" />
			)}
		</div>
	);
}
