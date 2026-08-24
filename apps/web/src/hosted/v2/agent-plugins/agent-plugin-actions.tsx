"use client";

import { AlertCircle, Check, Clock3, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Spinner } from "@/components/ui/spinner";
import {
	type AgentPluginActionState,
	type AgentPluginInventoryItem,
	type AgentPluginPrimaryAction,
	pluginDisplayName,
} from "./agent-plugin-model";

export type AgentPluginPendingAction = "install" | "remove" | "retry" | null;

export function AgentPluginActions({
	item,
	state,
	pendingAction,
	mutationsBlocked,
	onInstall,
	onRemove,
	onRetry,
}: {
	item: AgentPluginInventoryItem;
	state: AgentPluginActionState;
	pendingAction: AgentPluginPendingAction;
	mutationsBlocked: boolean;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRemove: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const title = pluginDisplayName(item);
	const removing = pendingAction === "remove";

	return (
		<>
			<AgentPluginPrimaryButton
				item={item}
				state={state}
				pendingAction={pendingAction}
				mutationsBlocked={mutationsBlocked}
				onInstall={onInstall}
				onRetry={onRetry}
			/>
			{item.desired ? (
				<ConfirmAction
					title={`Remove ${title}?`}
					description={<p>This removes its Skills and MCP servers from the agent.</p>}
					confirmLabel="Remove plugin"
					destructive
					onConfirm={() => onRemove(item)}
				>
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={mutationsBlocked}
						className="text-muted-foreground hover:text-destructive"
						title={removing ? `Removing ${title}` : `Remove ${title}`}
						aria-label={removing ? `Removing ${title}` : `Remove ${title}`}
					>
						{removing ? <Spinner aria-hidden /> : <Trash2 />}
					</Button>
				</ConfirmAction>
			) : null}
		</>
	);
}

function AgentPluginPrimaryButton({
	item,
	state,
	pendingAction,
	mutationsBlocked,
	onInstall,
	onRetry,
}: {
	item: AgentPluginInventoryItem;
	state: AgentPluginActionState;
	pendingAction: AgentPluginPendingAction;
	mutationsBlocked: boolean;
	onInstall: (item: AgentPluginInventoryItem) => Promise<unknown>;
	onRetry: (item: AgentPluginInventoryItem) => Promise<unknown>;
}) {
	const pendingInstall = pendingAction === "install" || pendingAction === "retry";
	const action: AgentPluginPrimaryAction | null = pendingInstall
		? { kind: "installing", label: "Installing…" }
		: state.primaryAction;
	if (!action) return null;

	const interactive =
		action.kind === "install" || action.kind === "update" || action.kind === "retry";
	const description =
		action.kind === "unavailable"
			? state.installability?.reason
			: action.kind === "waiting" || action.kind === "failed" || action.kind === "retry"
				? state.status?.description
				: null;
	const onClick =
		action.kind === "retry"
			? () => void onRetry(item).catch(() => undefined)
			: action.kind === "install" || action.kind === "update"
				? () => void onInstall(item).catch(() => undefined)
				: undefined;

	return (
		<Button
			size="sm"
			variant={
				action.kind === "retry" ? "destructive" : action.kind === "install" ? "default" : "outline"
			}
			className="w-40"
			disabled={mutationsBlocked || !interactive}
			title={description ?? undefined}
			aria-busy={action.kind === "installing"}
			onClick={onClick}
		>
			<PrimaryActionIcon kind={action.kind} />
			{action.label}
		</Button>
	);
}

function PrimaryActionIcon({ kind }: { kind: AgentPluginPrimaryAction["kind"] }) {
	switch (kind) {
		case "install":
			return <Plus />;
		case "installing":
			return <Spinner aria-hidden />;
		case "waiting":
			return <Clock3 />;
		case "installed":
			return <Check />;
		case "update":
		case "retry":
			return <RefreshCw />;
		case "failed":
			return <AlertCircle />;
		case "unavailable":
			return null;
	}
}
