"use client";

import type { components } from "@clawdi/shared/api";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	AgentLabel,
	AgentSourceBadgeForEnvironment,
	agentTextLabel,
	compareAgentEnvironments,
} from "@/components/dashboard/agent-label";
import { EmptyState } from "@/components/empty-state";
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
import { Skeleton } from "@/components/ui/skeleton";
import { TokenReveal } from "@/hosted/v2/channels/channel-ui";
import {
	useAgentChannelLinks,
	useCreateWhatsappTenantCred,
	useEnvironments,
	useLinkAgent,
} from "@/hosted/v2/channels/channels-hooks";
import {
	linkAgentBlockReason,
	shouldMintWhatsappTenantCredential,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import {
	type AgentOwnershipKind,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";

type Environment = components["schemas"]["AgentResponse"];

/**
 * Link an agent to a channel — instant, no token paste. On success
 * the scoped agent token is revealed once (the handle the agent runtime uses
 * to send/receive on this channel).
 */
export function LinkAgentDialog({
	open,
	onOpenChange,
	accountId,
	accountName,
	provider,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	accountName: string;
	provider: string;
}) {
	const envs = useEnvironments();
	const link = useLinkAgent(accountId);
	const createWhatsappCredential = useCreateWhatsappTenantCred(accountId);
	const ownership = useAgentOwnership();
	// Empty string is the "no selection" sentinel: keeps the Select controlled
	// (never flips undefined↔string, which warns), and reads as falsy so submit
	// stays gated. Radix renders the placeholder for value="".
	const [agentId, setAgentId] = useState("");
	const [token, setToken] = useState<string | null>(null);
	const [linkedNoToken, setLinkedNoToken] = useState(false);
	const [whatsappCredentialMinted, setWhatsappCredentialMinted] = useState(false);
	const submitLocked = useRef(false);

	const agents = useMemo(() => [...(envs.data ?? [])].sort(compareAgentEnvironments), [envs.data]);
	const selectedAgent = agents.find((env) => env.id === agentId);
	const shouldCheckHermesSingleLink =
		open &&
		Boolean(agentId) &&
		selectedAgent?.agent_type === "hermes" &&
		(provider === "telegram" || provider === "discord");
	const selectedAgentLinks = useAgentChannelLinks(agentId, shouldCheckHermesSingleLink);
	const blockReason = linkAgentBlockReason({
		provider,
		selectedAgent,
		existingAgentLinks: selectedAgentLinks.data ?? [],
		accountId,
	});
	const guardLoading = shouldCheckHermesSingleLink && selectedAgentLinks.isLoading;
	const isSubmitting = link.isPending || createWhatsappCredential.isPending || submitLocked.current;

	useEffect(() => {
		if (!open) return;
		setAgentId("");
		setToken(null);
		setLinkedNoToken(false);
		setWhatsappCredentialMinted(false);
	}, [open]);

	function submit() {
		if (!agentId || blockReason || guardLoading || submitLocked.current) return;
		const agent = selectedAgent;
		submitLocked.current = true;
		let credentialMutationStarted = false;
		link.mutate(agentId, {
			onSuccess: (data) => {
				if (shouldMintWhatsappTenantCredential(provider, agent)) {
					credentialMutationStarted = true;
					createWhatsappCredential.mutate(
						{ agent_link_id: data.id },
						{
							onSuccess: () => {
								setWhatsappCredentialMinted(true);
							},
							onSettled: () => {
								submitLocked.current = false;
							},
						},
					);
					return;
				}
				if (data.agent_token) setToken(data.agent_token);
				else setLinkedNoToken(true);
			},
			onSettled: () => {
				if (!credentialMutationStarted) {
					submitLocked.current = false;
				}
			},
		});
	}

	const agentItems = useMemo(
		() =>
			agents.map((env) => {
				const ownershipKind = agentOwnershipKindFromId(env.id, ownership);
				return {
					value: env.id,
					label: agentTextLabel(env, { ownershipKind }),
				};
			}),
		[agents, ownership],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Link an agent</DialogTitle>
					<DialogDescription>
						Connect one of your agents to <span className="font-medium">{accountName}</span>.
					</DialogDescription>
				</DialogHeader>

				{token ? (
					<TokenReveal
						label="Agent token"
						value={token}
						note="Copy it now — it won't be shown again. The agent runtime uses this to send and receive on this channel."
					/>
				) : whatsappCredentialMinted ? (
					<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted p-3 text-sm text-success-muted-foreground">
						<CircleCheck className="size-4 shrink-0" />
						Device credential minted. Finish pairing from the agent runtime to link the number.
					</div>
				) : linkedNoToken ? (
					<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted p-3 text-sm text-success-muted-foreground">
						<CircleCheck className="size-4 shrink-0" />
						This agent is already linked to the channel.
					</div>
				) : envs.isLoading ? (
					<Skeleton className="h-10 w-full rounded-md" />
				) : envs.error ? (
					<ApiErrorPanel
						error={envs.error}
						onRetry={() => envs.refetch()}
						title="Couldn't load agents"
					/>
				) : agents.length === 0 ? (
					<EmptyState
						variant="inset"
						title="No agents yet"
						description="Connect an agent first, then link it to this channel."
					/>
				) : (
					<div className="flex flex-col gap-2">
						<Label htmlFor="link-agent-select" className="sr-only">
							Agent
						</Label>
						<Select
							items={agentItems}
							value={agentId}
							onValueChange={(value) => {
								if (value !== null) setAgentId(value);
							}}
						>
							<SelectTrigger id="link-agent-select">
								<SelectValue placeholder="Choose an agent" />
							</SelectTrigger>
							<SelectContent>
								{agents.map((env) => {
									const ownershipKind = agentOwnershipKindFromId(env.id, ownership);
									return (
										<SelectItem
											key={env.id}
											value={env.id}
											label={agentOptionLabel(env, ownershipKind)}
										>
											<AgentOption env={env} ownershipKind={ownershipKind} />
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
						{guardLoading ? (
							<p className="text-xs text-muted-foreground">
								Checking existing Hermes channel links...
							</p>
						) : null}
						{blockReason ? (
							<div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-muted p-3 text-sm text-warning-muted-foreground">
								<TriangleAlert className="mt-0.5 size-4 shrink-0" />
								<span>{blockReason}</span>
							</div>
						) : null}
					</div>
				)}

				<DialogFooter>
					{token || linkedNoToken || whatsappCredentialMinted ? (
						<Button onClick={() => onOpenChange(false)}>Done</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button
								onClick={submit}
								disabled={!agentId || Boolean(blockReason) || guardLoading || isSubmitting}
							>
								{createWhatsappCredential.isPending
									? "Minting device…"
									: link.isPending
										? "Linking…"
										: "Link agent"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function agentOptionLabel(
	env: {
		id?: string | null;
		machine_name?: string | null;
		display_name?: string | null;
		agent_type?: string | null;
	},
	ownershipKind: AgentOwnershipKind,
): string {
	return agentTextLabel(env, { ownershipKind });
}

function AgentOption({
	env,
	ownershipKind,
}: {
	env: Environment;
	ownershipKind: AgentOwnershipKind;
}) {
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			titleAdornment={
				<AgentSourceBadgeForEnvironment env={env} ownershipKind={ownershipKind} compact />
			}
		/>
	);
}
