"use client";

import { Link2 } from "lucide-react";
import { useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { activeLinkedProviders } from "@/hosted/v2/channels/agent-channel-cards.logic";
import {
	agentProviderLinkReplacementRequired,
	agentProviderLinkStatusUnknown,
} from "@/hosted/v2/channels/channel-linking.logic";
import {
	ChannelPairingDialog,
	useChannelPairingFlow,
} from "@/hosted/v2/channels/channel-pairing-flow";
import {
	isWhatsAppRepairConflict,
	useAgentChannelLinks,
	useBotPool,
	useChannelAgentLinks,
	useChannels,
	useEnvironments,
	useLinkChannelAgent,
} from "@/hosted/v2/channels/channels-hooks";
import { ProviderLinkReplacementConfirm } from "@/hosted/v2/channels/provider-link-replacement-confirm";
import { WhatsAppRepairDialog } from "@/hosted/v2/channels/whatsapp-repair-dialog";
import { shouldBlockQueryError } from "@/lib/query-state";

/**
 * Complete channel-to-Agent workflow shared by channel details and inventory cards.
 * Linking stays in place and immediately continues into provider-specific chat pairing.
 */
export function LinkChannelAgentAction({
	accountId,
	provider,
	channelName,
	disabled = false,
	disabledReason,
}: {
	accountId: string;
	provider: string;
	channelName: string;
	disabled?: boolean;
	disabledReason?: string;
}) {
	const [open, setOpen] = useState(false);
	const [selectedAgentId, setSelectedAgentId] = useState("");
	const [whatsappRepair, setWhatsappRepair] = useState<{
		agentId: string;
		replaceExistingProviderLink: boolean;
	} | null>(null);

	const links = useChannelAgentLinks(accountId, open);
	const envs = useEnvironments();
	const channels = useChannels();
	const botPool = useBotPool();
	const linkAgent = useLinkChannelAgent(accountId);
	const selectedAgentLinks = useAgentChannelLinks(selectedAgentId, Boolean(selectedAgentId));
	const pairing = useChannelPairingFlow(accountId);

	const items = links.data ?? [];
	const linkedAgentIds = useMemo(() => new Set(items.map((item) => item.agent_id)), [items]);
	const availableAgents = useMemo(
		() => (envs.data ?? []).filter((env) => !linkedAgentIds.has(env.id)),
		[envs.data, linkedAgentIds],
	);
	const selectedAgent = availableAgents.find((env) => env.id === selectedAgentId);
	const selectedLinkedProviders = useMemo(
		() =>
			selectedAgentLinks.data
				? activeLinkedProviders({
						links: selectedAgentLinks.data,
						channels: channels.data ?? [],
						poolProviders: botPool.data?.providers,
					})
				: undefined,
		[selectedAgentLinks.data, channels.data, botPool.data],
	);
	const replacementRequired = agentProviderLinkReplacementRequired(
		selectedAgent?.agent_type,
		provider,
		selectedLinkedProviders,
	);
	const linkStatusUnknown = agentProviderLinkStatusUnknown(
		selectedAgent?.agent_type,
		provider,
		selectedLinkedProviders,
	);
	const submitLink = async (agentId: string, replaceExistingProviderLink: boolean) => {
		if (!agentId || linkAgent.isPending) return;
		try {
			const result = await linkAgent.execute({ agentId, replaceExistingProviderLink });
			setOpen(false);
			setSelectedAgentId("");
			await pairing.openPairing(result);
		} catch (error) {
			if (isWhatsAppRepairConflict(error)) {
				setWhatsappRepair({ agentId, replaceExistingProviderLink });
				setOpen(false);
			}
			// The shared mutation presents every other provider or runtime error.
		}
	};

	const linkButton = (
		<Button
			disabled={!selectedAgentId || linkStatusUnknown || linkAgent.isPending}
			onClick={replacementRequired ? undefined : () => void submitLink(selectedAgentId, false)}
		>
			{linkAgent.isPending ? <Spinner className="size-3.5" /> : <Link2 />}
			{linkAgent.isPending ? "Linking…" : "Link Agent"}
		</Button>
	);
	const linksError = shouldBlockQueryError(links.error, links.data) ? links.error : null;
	const envsError = shouldBlockQueryError(envs.error, envs.data) ? envs.error : null;
	const disabledDescriptionId = disabledReason ? `link-agent-reason-${accountId}` : undefined;

	return (
		<span data-hosted="true" data-v2="true" className="contents">
			<Button
				size="sm"
				variant="outline"
				aria-disabled={disabled}
				aria-describedby={disabledDescriptionId}
				className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
				title={disabledReason}
				onClick={() => {
					if (!disabled) setOpen(true);
				}}
			>
				<Link2 className="size-3.5" />
				Link Agent
			</Button>
			{disabledDescriptionId ? (
				<span id={disabledDescriptionId} className="sr-only">
					{disabledReason}
				</span>
			) : null}

			<Dialog
				open={open}
				onOpenChange={setOpen}
				onOpenChangeComplete={(nextOpen) => {
					if (!nextOpen) setSelectedAgentId("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Link Agent</DialogTitle>
						<DialogDescription>
							Choose an Agent, then pair one of its chats without leaving this channel.
						</DialogDescription>
					</DialogHeader>
					{linksError ? (
						<ApiErrorPanel
							error={linksError}
							onRetry={() => links.refetch()}
							title="Couldn't load linked Agents"
						/>
					) : envsError ? (
						<ApiErrorPanel
							error={envsError}
							onRetry={() => envs.refetch()}
							title="Couldn't load Agents"
						/>
					) : links.isLoading || envs.isLoading ? (
						<Skeleton className="h-9 w-full rounded-md" />
					) : availableAgents.length > 0 ? (
						<div className="space-y-1.5">
							<Label htmlFor={`channel-link-agent-${accountId}`}>Agent</Label>
							<Select
								items={availableAgents.map((env) => ({
									value: env.id,
									label: agentDisplayName(env),
								}))}
								value={selectedAgentId}
								onValueChange={(value) => setSelectedAgentId(value ?? "")}
							>
								<SelectTrigger id={`channel-link-agent-${accountId}`} className="w-full">
									<SelectValue placeholder="Choose an Agent…" />
								</SelectTrigger>
								<SelectContent>
									{availableAgents.map((env) => (
										<SelectItem key={env.id} value={env.id}>
											{agentDisplayName(env)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">Every available Agent is linked.</p>
					)}
					{selectedAgentId &&
					shouldBlockQueryError(selectedAgentLinks.error, selectedAgentLinks.data) ? (
						<ApiErrorPanel
							error={selectedAgentLinks.error}
							onRetry={() => selectedAgentLinks.refetch()}
							title="Couldn't check this Agent's existing links"
						/>
					) : null}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						{replacementRequired ? (
							<ProviderLinkReplacementConfirm
								provider={provider}
								targetName={channelName}
								onConfirm={() => submitLink(selectedAgentId, true)}
							>
								{linkButton}
							</ProviderLinkReplacementConfirm>
						) : (
							linkButton
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ChannelPairingDialog
				accountId={accountId}
				provider={provider}
				channelName={channelName}
				flow={pairing}
			/>

			{whatsappRepair ? (
				<WhatsAppRepairDialog
					open
					accountId={accountId}
					channelName={channelName}
					onOpenChange={(nextOpen) => {
						if (!nextOpen) setWhatsappRepair(null);
					}}
					onRepaired={() => {
						const repaired = whatsappRepair;
						setWhatsappRepair(null);
						void submitLink(repaired.agentId, repaired.replaceExistingProviderLink);
					}}
				/>
			) : null}
		</span>
	);
}
