"use client";

import { Download } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { agentDisplayName } from "@/components/dashboard/agent-label";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useSkillReferenceMutation } from "@/hosted/agents/agent-skills-query";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { isHostedDeploymentVisible } from "@/hosted/hosted-agent-resolution";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";

export default function LibrarySkillInstallAction({
	skill,
}: {
	skill: components["schemas"]["SkillSummaryResponse"];
}) {
	const [open, setOpen] = useState(false);
	const [agentId, setAgentId] = useState("");
	const locked = useRef(false);
	const inventory = useHostedDeploymentInventory({ enabled: open });
	const cloudAgents = useOpenApi().useQuery("get", "/v1/agents", {}, { enabled: open });
	const hostedIds = new Set(
		(inventory.deployments ?? [])
			.filter(isHostedDeploymentVisible)
			.map((deployment) => deployment.agent_id),
	);
	const agents = (cloudAgents.data ?? [])
		.filter((agent) => hostedIds.has(agent.id))
		.map((agent) => ({ value: agent.id, label: agentDisplayName(agent) }));
	const agentsLoading = inventory.status === "loading" || cloudAgents.isLoading;
	const install = useSkillReferenceMutation(agentId);
	async function submit() {
		if (locked.current || !agents.some((agent) => agent.value === agentId)) return;
		locked.current = true;
		try {
			await install.mutateAsync({ action: "install", skillId: skill.id });
			toast.success("Skill installed");
			setOpen(false);
		} catch (error) {
			toast.error("Couldn't install Skill", { description: normalizeApiError(error) });
		} finally {
			locked.current = false;
		}
	}
	return (
		<span data-hosted="true" className="contents">
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`Install ${skill.name} on an Agent`}
				onClick={() => setOpen(true)}
			>
				<Download className="size-3.5" />
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!install.isPending) setOpen(next);
				}}
				onOpenChangeComplete={(next) => {
					if (!next) {
						setAgentId("");
						install.reset();
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Install skill</DialogTitle>
						<DialogDescription>
							Choose an Agent to use {skill.name}. Changes in your Library will update it
							automatically.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label>Agent</Label>
						<Select
							items={agents}
							value={agentId}
							onValueChange={(id) => {
								setAgentId(id ?? "");
								install.reset();
							}}
							disabled={install.isPending || agentsLoading}
						>
							<SelectTrigger className="w-full" aria-label="Target Agent">
								<SelectValue placeholder="Choose an Agent" />
							</SelectTrigger>
							<SelectContent>
								{agents.map((agent) => (
									<SelectItem key={agent.value} value={agent.value}>
										{agent.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{!agentsLoading && !inventory.error && agents.length === 0 ? (
							<p className="text-sm text-muted-foreground">No Hosted Agents are available yet.</p>
						) : null}
					</div>
					{inventory.error ? (
						<ApiErrorPanel
							error={inventory.error}
							normalizer={billingErrorNormalizer}
							onRetry={() => void inventory.refetch()}
							title="Couldn't load Agents"
						/>
					) : null}
					{cloudAgents.error ? (
						<ApiErrorPanel
							error={cloudAgents.error}
							onRetry={() => void cloudAgents.refetch()}
							title="Couldn't load Agents"
						/>
					) : null}
					{install.error ? (
						<p className="text-sm text-destructive" role="alert">
							{normalizeApiError(install.error)}
						</p>
					) : null}
					<DialogFooter>
						<Button variant="outline" disabled={install.isPending} onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							disabled={
								!agentId || install.isPending || Boolean(inventory.error || cloudAgents.error)
							}
							onClick={() => void submit()}
						>
							{install.isPending ? <Spinner /> : null}Install skill
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</span>
	);
}
