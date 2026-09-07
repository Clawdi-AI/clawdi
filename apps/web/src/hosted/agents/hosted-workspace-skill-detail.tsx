"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useSetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { useAgentProjectBindings } from "@/components/dashboard/agent-project-bindings-query";
import { DetailBackLink } from "@/components/detail/back-link";
import { DetailPanel } from "@/components/detail/layout";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { agentManagedSkillsKey, useAgentManagedSkills } from "@/hosted/agents/agent-skills-query";
import { useAgentDeployment } from "@/hosted/agents/deployment-hooks";
import { workspaceSkillErrorNormalizer } from "@/hosted/agents/workspace-skill-errors";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { billingKeys } from "@/hosted/billing/query-keys";
import { agentProjectResourceHref } from "@/lib/agent-routes";
import { unwrap, useApi } from "@/lib/api";
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
	const api = useApi();
	const bindings = useAgentProjectBindings(agentId);
	const resolution = useAgentDeployment(agentId, useDeploymentEventStreamActive());
	const deploymentId = resolution.deployment?.resource.id;
	const isWorkspace = bindings.data?.some(
		(binding) => binding.project_id === projectId && binding.binding_type === "primary",
	);
	const managedSkills = useAgentManagedSkills(agentId, Boolean(isWorkspace && deploymentId));
	const managed = managedSkills.data?.skills.find((skill) => skill.skill_key === skillKey);
	const referenceId = managed?.source === "library" ? managed.skill_id : null;
	const inventory = useQuery({
		queryKey: billingKeys.workspaceSkills(deploymentId ?? ""),
		queryFn: () => {
			if (!deploymentId) throw new Error("Agent is unavailable");
			return client.listWorkspaceSkills(deploymentId);
		},
		enabled: Boolean(isWorkspace && deploymentId && managedSkills.data && !referenceId),
	});
	const desired = inventory.data?.items?.find((skill) => skill.skill_key === skillKey);
	const detail = useQuery({
		queryKey: [
			...agentManagedSkillsKey(agentId),
			"detail",
			skillKey,
			desired?.source.commit,
			managed?.source_identity,
		],
		queryFn: async () => {
			if (referenceId) {
				const skill = unwrap(
					await api.GET("/v1/agents/{agent_id}/skill-references/{skill_id}", {
						params: { path: { agent_id: agentId, skill_id: referenceId } },
					}),
				);
				return { kind: "library" as const, skill };
			}
			if (!deploymentId) throw new Error("Agent is unavailable");
			return {
				kind: "github" as const,
				skill: await client.getWorkspaceSkill(deploymentId, skillKey),
			};
		},
		enabled: Boolean(isWorkspace && deploymentId && (desired || referenceId)),
	});
	const { copy } = useCopyToClipboard({ success: "Skill copied", error: "Couldn't copy Skill" });
	const skill = detail.data?.skill;
	useSetBreadcrumbTitle(desired || referenceId ? (skill?.name ?? skillKey) : null);

	if (bindings.data && !isWorkspace) return children;
	if (resolution.membershipResolved && !resolution.deployment && !resolution.error) return children;
	if (
		inventory.data &&
		managedSkills.data &&
		!desired &&
		!referenceId &&
		!inventory.error &&
		!managedSkills.error
	)
		return children;

	const error =
		(shouldBlockQueryError(bindings.error, bindings.data) ? bindings.error : null) ??
		resolution.error ??
		managedSkills.error ??
		(!referenceId ? inventory.error : null) ??
		detail.error;
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
						else if (managedSkills.error) void managedSkills.refetch();
						else if (inventory.error) void inventory.refetch();
						else void detail.refetch();
					}}
				/>
			) : skill ? (
				<>
					<PageHeader
						title={skill.name}
						description={skill.description ?? undefined}
						actions={
							<Button
								variant="outline"
								size="sm"
								disabled={!skill.content}
								onClick={() => {
									if (skill.content) void copy(skill.content);
								}}
							>
								<Copy className="size-3.5" /> Copy skill
							</Button>
						}
					/>
					{detail.data?.kind === "github" ? (
						<a
							href={`${detail.data.skill.source.url}/tree/${detail.data.skill.source.commit}/${detail.data.skill.source.path.split("/").map(encodeURIComponent).join("/")}`}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
						>
							<ExternalLink className="size-3.5" /> View source on GitHub
						</a>
					) : detail.data?.kind === "library" && detail.data.skill.project_id ? (
						<Link
							to="/skills/$key"
							params={{ key: detail.data.skill.skill_key }}
							search={{ project: detail.data.skill.project_id }}
							className="text-sm text-muted-foreground hover:text-foreground"
						>
							View in Library
						</Link>
					) : null}
					<DetailPanel>
						{skill.content ? (
							<Markdown content={stripFrontmatter(skill.content)} />
						) : (
							<EmptyState
								variant="inset"
								description="Skill instructions aren't available right now."
								action={
									<Button
										variant="outline"
										size="sm"
										disabled={detail.isFetching}
										onClick={() => void detail.refetch()}
									>
										Retry
									</Button>
								}
							/>
						)}
					</DetailPanel>
				</>
			) : (
				<Skeleton className="h-40 rounded-lg" />
			)}
		</div>
	);
}
