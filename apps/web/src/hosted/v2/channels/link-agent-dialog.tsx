"use client";

import type { components } from "@clawdi/shared/api";
import { Link, useSearch } from "@tanstack/react-router";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	AgentLabel,
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
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAgentLink } from "@/hosted/v2/channels/channel-types";
import {
	useAgentChannelLinks,
	useChannelAgentLinks,
	useCreateWhatsappTenantCred,
	useEnvironments,
	useLinkAgent,
} from "@/hosted/v2/channels/channels-hooks";
import {
	agentProviderHasSingleLinkLimit,
	linkAgentBlockReason,
	selectCloudAgentCandidates,
	shouldMintWhatsappTenantCredential,
} from "@/hosted/v2/channels/link-agent-dialog.logic";
import { TelegramPairDialog } from "@/hosted/v2/channels/telegram-pair-dialog";
import { useAgentOwnership } from "@/lib/agent-ownership";
import { agentDeploymentRouteQuery, agentSectionLink } from "@/lib/agent-routes";

type Environment = components["schemas"]["AgentResponse"];

/**
 * Link an agent to a channel. Hosted runtime credentials reconcile automatically.
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
	const accountLinks = useChannelAgentLinks(accountId);
	const link = useLinkAgent(accountId);
	const createWhatsappCredential = useCreateWhatsappTenantCred(accountId);
	const ownership = useAgentOwnership();
	const inventory = useHostedDeploymentInventory();
	const routeSearch = useSearch({ from: "/_protected/_dashboard" });
	// Empty string is the "no selection" sentinel: keeps the Select controlled
	// (never flips undefined↔string, which warns), and reads as falsy so submit
	// stays gated. Radix renders the placeholder for value="".
	const [agentId, setAgentId] = useState("");
	const [linked, setLinked] = useState<ChannelAgentLink | null>(null);
	const [whatsappCredentialMinted, setWhatsappCredentialMinted] = useState(false);
	const [telegramPairOpen, setTelegramPairOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const submitLocked = useRef(false);
	const openRef = useRef(open);
	const dialogSessionRef = useRef(0);
	openRef.current = open;

	const agents = useMemo(
		() =>
			selectCloudAgentCandidates(envs.data ?? [], ownership, accountLinks.data ?? []).sort(
				compareAgentEnvironments,
			),
		[accountLinks.data, envs.data, ownership],
	);
	const selectedAgent = agents.find((env) => env.id === agentId);
	const shouldCheckSingleLink =
		open &&
		Boolean(agentId) &&
		agentProviderHasSingleLinkLimit(selectedAgent?.agent_type, provider);
	const selectedAgentLinks = useAgentChannelLinks(agentId, shouldCheckSingleLink);
	const blockReason = linkAgentBlockReason({
		provider,
		selectedAgent,
		existingAgentLinks: selectedAgentLinks.data ?? [],
		accountId,
	});
	const guardLoading = shouldCheckSingleLink && selectedAgentLinks.isLoading;
	const guardError = shouldCheckSingleLink ? selectedAgentLinks.error : null;
	const candidateGuardLoading =
		envs.isLoading ||
		accountLinks.isLoading ||
		ownership === null ||
		inventory.status === "loading";
	const candidateGuardError = envs.error ?? accountLinks.error ?? inventory.error;
	const isSubmitting = submitting || link.isPending || createWhatsappCredential.isPending;
	const submitBlocked =
		!selectedAgent ||
		Boolean(blockReason) ||
		guardLoading ||
		Boolean(guardError) ||
		candidateGuardLoading ||
		Boolean(candidateGuardError);

	useEffect(() => {
		if (!open) return;
		setAgentId("");
		setLinked(null);
		setWhatsappCredentialMinted(false);
		setTelegramPairOpen(false);
	}, [open]);

	async function submit() {
		if (!agentId || submitBlocked || submitLocked.current) return;
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
				setLinked(data);
			} else {
				toast.success("Agent linked", {
					description: `${accountName} is linked. Open the agent's Channels tab to pair a chat.`,
				});
			}
		} catch {
			// The sensitive action hooks already surface API failures.
			void accountLinks.refetch();
			void selectedAgentLinks.refetch();
			void envs.refetch();
		} finally {
			submitLocked.current = false;
			setSubmitting(false);
		}
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			dialogSessionRef.current += 1;
			setLinked(null);
		}
		onOpenChange(nextOpen);
	}

	const agentItems = useMemo(
		() => agents.map((env) => ({ value: env.id, label: agentOptionLabel(env) })),
		[agents],
	);
	const linkComplete = Boolean(linked) || whatsappCredentialMinted;

	return (
		<>
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{linkComplete ? "Agent linked" : "Link an agent"}</DialogTitle>
						<DialogDescription>
							{linkComplete ? (
								provider === "telegram" && linked ? (
									<>
										<span className="font-medium">{accountName}</span> is linked. Pair a Telegram
										chat now or manage it from the Agent.
									</>
								) : (
									<>
										<span className="font-medium">{accountName}</span> is linked. Finish setup from
										the Agent's Channels page.
									</>
								)
							) : (
								<>
									Connect one of your agents to <span className="font-medium">{accountName}</span>.
								</>
							)}
						</DialogDescription>
					</DialogHeader>

					{linked ? (
						<div className="rounded-lg border border-success/30 bg-success-muted p-3 text-sm">
							<div className="flex items-start gap-2 text-success-muted-foreground">
								<CircleCheck className="mt-0.5 size-4 shrink-0" />
								<div>
									<p className="font-medium">Linked · syncing automatically</p>
									{provider === "telegram" ? null : (
										<p className="mt-1 text-xs">
											Next, create a {providerMeta(provider).label} pairing code for the chat where
											it should answer.
										</p>
									)}
								</div>
							</div>
						</div>
					) : whatsappCredentialMinted ? (
						<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted p-3 text-sm text-success-muted-foreground">
							<CircleCheck className="size-4 shrink-0" />
							WhatsApp access is ready. Open the agent’s Channels page to finish linking the number.
						</div>
					) : candidateGuardLoading ? (
						<Skeleton className="h-10 w-full rounded-md" />
					) : candidateGuardError ? (
						<ApiErrorPanel
							error={candidateGuardError}
							onRetry={() => {
								void envs.refetch();
								void accountLinks.refetch();
								void inventory.refetch();
							}}
							title="Couldn't verify Cloud Agents"
						/>
					) : agents.length === 0 ? (
						<EmptyState
							variant="inset"
							title="No Cloud Agents available"
							description="Create a Cloud Agent or unlink one already connected to this bot."
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
								<SelectTrigger id="link-agent-select" className="w-full min-w-0">
									<SelectValue placeholder="Choose an agent" />
								</SelectTrigger>
								<SelectContent
									align="start"
									alignItemWithTrigger={false}
									className="w-[min(var(--anchor-width),calc(100vw-2rem))] max-w-[calc(100vw-2rem)]"
								>
									{agents.map((env) => {
										return (
											<SelectItem key={env.id} value={env.id} label={agentOptionLabel(env)}>
												<AgentOption env={env} />
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
							{guardLoading ? (
								<p className="text-xs text-muted-foreground">Checking existing channel links…</p>
							) : null}
							{guardError ? (
								<ApiErrorPanel
									error={guardError}
									onRetry={() => selectedAgentLinks.refetch()}
									title="Couldn't verify existing channel links"
								/>
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
								<Button
									render={
										<Link
											{...agentSectionLink(
												agentId,
												"channels",
												agentDeploymentRouteQuery(routeSearch),
											)}
										/>
									}
									nativeButton={false}
									variant={provider === "telegram" && linked ? "outline" : "default"}
								>
									Open Agent Channels
								</Button>
								{provider === "telegram" && linked ? (
									<Button onClick={() => setTelegramPairOpen(true)}>Pair Telegram</Button>
								) : (
									<Button variant="outline" onClick={() => handleOpenChange(false)}>
										Close
									</Button>
								)}
							</>
						) : (
							<>
								<Button variant="outline" onClick={() => handleOpenChange(false)}>
									{isSubmitting ? "Close" : "Cancel"}
								</Button>
								<Button onClick={() => void submit()} disabled={submitBlocked || isSubmitting}>
									{isSubmitting ? "Linking…" : "Link agent"}
								</Button>
							</>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{linked && provider === "telegram" ? (
				<TelegramPairDialog
					open={telegramPairOpen}
					onOpenChange={setTelegramPairOpen}
					accountId={accountId}
					agentLinkId={linked.id}
					agentName={selectedAgent ? agentOptionLabel(selectedAgent) : undefined}
					channelName={accountName}
				/>
			) : null}
		</>
	);
}

function agentOptionLabel(env: {
	id?: string | null;
	machine_name?: string | null;
	display_name?: string | null;
	agent_type?: string | null;
}): string {
	return agentTextLabel(env, {
		includeSource: false,
		formatName: runtimeNameFormatter(env),
	});
}

function runtimeNameFormatter(env: { agent_type?: string | null }) {
	const runtime = env.agent_type;
	return runtime && isHostedRuntime(runtime)
		? (name: string) => deploymentDisplayName(name, runtime)
		: undefined;
}

function AgentOption({ env }: { env: Environment }) {
	return (
		<AgentLabel
			machineName={env.machine_name}
			displayName={env.display_name}
			defaultName={env.default_name}
			type={env.agent_type}
			avatarUrl={env.avatar_url}
			size="sm"
			formatName={runtimeNameFormatter(env)}
		/>
	);
}
