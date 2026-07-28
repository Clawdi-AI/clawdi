"use client";

import type { components } from "@clawdi/shared/api";
import { Link } from "@tanstack/react-router";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { deploymentDisplayName } from "@/hosted/agent-identity";
import { isHostedRuntime } from "@/hosted/runtimes";
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
import { agentSectionHref } from "@/lib/agent-routes";

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
	const [submitting, setSubmitting] = useState(false);
	const submitLocked = useRef(false);
	const openRef = useRef(open);
	const dialogSessionRef = useRef(0);
	openRef.current = open;

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
	const isSubmitting = submitting || link.isPending || createWhatsappCredential.isPending;

	useEffect(() => {
		if (!open) return;
		setAgentId("");
		setToken(null);
		setLinkedNoToken(false);
		setWhatsappCredentialMinted(false);
	}, [open]);

	async function submit() {
		if (!agentId || blockReason || guardLoading || submitLocked.current) return;
		const agent = selectedAgent;
		submitLocked.current = true;
		setSubmitting(true);
		const dialogSession = dialogSessionRef.current;
		try {
			const data = await link.execute(agentId);
			if (shouldMintWhatsappTenantCredential(provider, agent)) {
				await createWhatsappCredential.execute({ agent_link_id: data.id });
				if (openRef.current && dialogSessionRef.current === dialogSession) {
					setWhatsappCredentialMinted(true);
				} else {
					toast.success("Agent linked", {
						description: `${accountName} is linked. Open the agent’s Channels page to finish device pairing.`,
					});
				}
				return;
			}
			if (openRef.current && dialogSessionRef.current === dialogSession) {
				if (data.agent_token) setToken(data.agent_token);
				else setLinkedNoToken(true);
			} else {
				toast.success("Agent linked", {
					description: `${accountName} is linked. Open the agent's Channels tab to pair a chat.`,
				});
			}
		} catch {
			// The sensitive action hooks already surface API failures.
		} finally {
			submitLocked.current = false;
			setSubmitting(false);
		}
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			dialogSessionRef.current += 1;
			setToken(null);
		}
		onOpenChange(nextOpen);
	}

	const agentItems = useMemo(
		() =>
			agents.map((env) => {
				const ownershipKind = agentOwnershipKindFromId(env.id, ownership);
				return {
					value: env.id,
					label: agentOptionLabel(env, ownershipKind),
				};
			}),
		[agents, ownership],
	);
	const linkComplete = Boolean(token || linkedNoToken || whatsappCredentialMinted);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{linkComplete ? "Agent linked" : "Link an agent"}</DialogTitle>
					<DialogDescription>
						{linkComplete ? (
							<>
								<span className="font-medium">{accountName}</span> is linked. Finish setup from the
								agent's Channels page.
							</>
						) : (
							<>
								Connect one of your agents to <span className="font-medium">{accountName}</span>.
							</>
						)}
					</DialogDescription>
				</DialogHeader>

				{token || linkedNoToken ? (
					<div className="space-y-3 rounded-lg border border-success/30 bg-success-muted p-3 text-sm">
						<div className="flex items-start gap-2 text-success-muted-foreground">
							<CircleCheck className="mt-0.5 size-4 shrink-0" />
							<div>
								<p className="font-medium">The bot is linked to this agent</p>
								<p className="mt-1 text-xs">
									Next, create a pairing code and send it in the exact chat where the agent should
									answer.
								</p>
							</div>
						</div>
						{token ? (
							<details className="rounded-md border bg-background p-3">
								<summary className="cursor-pointer text-xs font-medium">
									Agent token (advanced)
								</summary>
								<div className="mt-2">
									<TokenReveal
										label="Agent token"
										value={token}
										note="Clawdi agents configure this automatically. Only copy it for a self-managed agent that asks for it."
									/>
								</div>
							</details>
						) : null}
					</div>
				) : whatsappCredentialMinted ? (
					<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted p-3 text-sm text-success-muted-foreground">
						<CircleCheck className="size-4 shrink-0" />
						WhatsApp access is ready. Open the agent’s Channels page to finish linking the number.
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
					{linkComplete ? (
						<>
							<Button variant="outline" onClick={() => handleOpenChange(false)}>
								Close
							</Button>
							<Button
								render={<Link to={agentSectionHref(agentId, "channels")} />}
								nativeButton={false}
							>
								Finish channel setup
							</Button>
						</>
					) : (
						<>
							<Button variant="outline" onClick={() => handleOpenChange(false)}>
								{isSubmitting ? "Close" : "Cancel"}
							</Button>
							<Button
								onClick={() => void submit()}
								disabled={!agentId || Boolean(blockReason) || guardLoading || isSubmitting}
							>
								{isSubmitting ? "Linking…" : "Link agent"}
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
	return agentTextLabel(env, { ownershipKind, formatName: runtimeNameFormatter(env) });
}

function runtimeNameFormatter(env: { agent_type?: string | null }) {
	const runtime = env.agent_type;
	return runtime && isHostedRuntime(runtime)
		? (name: string) => deploymentDisplayName(name, runtime)
		: undefined;
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
			formatName={runtimeNameFormatter(env)}
			titleAdornment={
				<AgentSourceBadgeForEnvironment env={env} ownershipKind={ownershipKind} compact />
			}
		/>
	);
}
