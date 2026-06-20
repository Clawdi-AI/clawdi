"use client";

import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ChannelError, TokenReveal } from "@/hosted/channels/channel-ui";
import { useEnvironments, useLinkAgent } from "@/hosted/channels/channels-hooks";

/**
 * Link a connected agent to a channel — instant, no token paste. On success
 * the scoped agent token is revealed once (the handle the agent runtime uses
 * to send/receive on this channel).
 */
export function LinkAgentDialog({
	open,
	onOpenChange,
	accountId,
	accountName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	accountName: string;
}) {
	const envs = useEnvironments();
	const link = useLinkAgent(accountId);
	// Empty string is the "no selection" sentinel: keeps the Select controlled
	// (never flips undefined↔string, which warns), and reads as falsy so submit
	// stays gated. Radix renders the placeholder for value="".
	const [agentId, setAgentId] = useState("");
	const [token, setToken] = useState<string | null>(null);
	const [linkedNoToken, setLinkedNoToken] = useState(false);

	useEffect(() => {
		if (!open) {
			setAgentId("");
			setToken(null);
			setLinkedNoToken(false);
		}
	}, [open]);

	function submit() {
		if (!agentId) return;
		link.mutate(agentId, {
			onSuccess: (data) => {
				if (data.agent_token) setToken(data.agent_token);
				else setLinkedNoToken(true);
			},
		});
	}

	const agents = envs.data ?? [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-hosted="true" className="sm:max-w-md">
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
				) : linkedNoToken ? (
					<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-muted p-3 text-sm text-success-muted-foreground">
						<CircleCheck className="size-4 shrink-0" />
						This agent is already linked to the channel.
					</div>
				) : envs.isLoading ? (
					<Skeleton className="h-10 w-full rounded-md" />
				) : envs.error ? (
					<ChannelError
						error={envs.error}
						onRetry={() => envs.refetch()}
						title="Couldn't load agents"
					/>
				) : agents.length === 0 ? (
					<EmptyState
						title="No agents yet"
						description="Connect an agent first, then link it to this channel."
						fillHeight={false}
					/>
				) : (
					<div className="space-y-2">
						<Select value={agentId} onValueChange={setAgentId}>
							<SelectTrigger>
								<SelectValue placeholder="Choose an agent" />
							</SelectTrigger>
							<SelectContent>
								{agents.map((env) => (
									<SelectItem key={env.id} value={env.id}>
										{env.machine_name} · {agentTypeLabel(env.agent_type)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<DialogFooter>
					{token || linkedNoToken ? (
						<Button onClick={() => onOpenChange(false)}>Done</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button onClick={submit} disabled={!agentId || link.isPending}>
								{link.isPending ? "Linking…" : "Link agent"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
