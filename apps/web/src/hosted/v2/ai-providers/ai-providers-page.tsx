"use client";

import { CircleAlert, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CARD_BASE,
	ENTITY_GRID_CLASS,
	EntityCardSkeleton,
	EntityHeader,
} from "@/components/entity-card";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SectionLabel } from "@/components/section-label";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { useDeleteProvider, useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import {
	type ProviderUsage,
	providerRemovalImpact,
	providerUsage,
} from "@/hosted/v2/ai-providers/ai-providers-page.logic";
import {
	AuthBadge,
	ManagedProviderCard,
	ProviderIcon,
	ProviderReadinessBadge,
} from "@/hosted/v2/ai-providers/ai-providers-ui";
import { providerPresentation } from "@/hosted/v2/ai-providers/model-binding";
import { ProviderConnectionTest } from "@/hosted/v2/ai-providers/provider-connection-test";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Choose how your agents reach a model.";
const PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const PROVIDER_GRID_CLASS = ENTITY_GRID_CLASS;

export function AiProvidersPage() {
	const providers = useUserAiProviders();
	const inventory = useHostedDeploymentInventory();
	const [addOpen, setAddOpen] = useState(false);
	const [editing, setEditing] = useState<AiProvider | null>(null);

	const list = providers.data ?? [];
	const blockingProvidersError = shouldBlockQueryError(providers.error, providers.data)
		? providers.error
		: null;

	return (
		<div data-hosted="true" data-v2="true" className={PAGE_CLASS}>
			<PageHeader
				title="AI Providers"
				description={DESCRIPTION}
				actions={
					<Button
						size="sm"
						disabled={providers.data === undefined}
						onClick={() => {
							setEditing(null);
							setAddOpen(true);
						}}
					>
						<Plus />
						Add provider
					</Button>
				}
			/>

			<div className="flex flex-col gap-2">
				<SectionLabel>Clawdi</SectionLabel>
				<ManagedProviderCard />
			</div>

			<div className="flex flex-col gap-2">
				<SectionLabel
					count={!providers.isLoading && !blockingProvidersError ? list.length : undefined}
				>
					Your providers
				</SectionLabel>
				{blockingProvidersError ? (
					<ApiErrorPanel
						error={blockingProvidersError}
						onRetry={() => providers.refetch()}
						title="Couldn’t load providers"
					/>
				) : providers.isLoading ? (
					<div className={PROVIDER_GRID_CLASS}>
						{[0, 1, 2].map((i) => (
							<EntityCardSkeleton key={i} metaLines={2} actions />
						))}
					</div>
				) : list.length === 0 ? (
					<EmptyState
						title="No providers added"
						description="Connect a provider to use your own model access with agents."
						action={
							<Button
								variant="outline"
								onClick={() => {
									setEditing(null);
									setAddOpen(true);
								}}
							>
								<Plus />
								Add provider
							</Button>
						}
					/>
				) : (
					<div className={PROVIDER_GRID_CLASS}>
						{list.map((provider) => (
							<ProviderCard
								key={provider.provider_id}
								provider={provider}
								usage={providerUsage(provider.provider_id, inventory.deployments)}
								onEdit={() => {
									setEditing(provider);
									setAddOpen(true);
								}}
							/>
						))}
					</div>
				)}
			</div>

			<AddProviderDialog open={addOpen} onOpenChange={setAddOpen} editing={editing} />
		</div>
	);
}

function ProviderCard({
	provider,
	usage,
	onEdit,
}: {
	provider: AiProvider;
	usage: ProviderUsage;
	onEdit: () => void;
}) {
	const presentation = providerPresentation(provider);
	const deployable =
		(provider.readiness?.deployable ?? provider.usable) && provider.auth.type !== "none";

	return (
		<div className={cn(ENTITY_CARD_BASE, "flex h-full flex-col")}>
			<EntityHeader
				align="start"
				icon={<ProviderIcon provider={provider} />}
				title={presentation.label}
				titleAdornment={
					<span className="inline-flex items-center gap-1.5">
						<AuthBadge auth={provider.auth} />
						<ProviderReadinessBadge deployable={deployable} />
					</span>
				}
				meta={[
					presentation.summary,
					provider.auth.type === "none"
						? "Add a credential before assigning this provider to an agent."
						: deployable
							? null
							: provider.usable
								? "This setup isn't available for hosted agents. Review Advanced settings."
								: "Finish setup before assigning this provider to an agent.",
				]}
			/>
			<div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
				<ProviderConnectionTest provider={provider} providerLabel={presentation.label} />
				<Button
					variant="outline"
					size="sm"
					onClick={onEdit}
					aria-label={`${deployable ? "Edit" : "Finish setup for"} ${presentation.label}`}
				>
					{deployable ? <Pencil /> : <CircleAlert />}
					{deployable ? "Edit" : "Finish setup"}
				</Button>
				<RemoveProviderAction provider={provider} usage={usage} />
			</div>
		</div>
	);
}

function RemoveProviderAction({ provider, usage }: { provider: AiProvider; usage: ProviderUsage }) {
	const del = useDeleteProvider();
	const [open, setOpen] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const providerLabel = providerPresentation(provider).label;
	const impact = providerRemovalImpact(usage);
	const revokesChatGpt =
		(provider.auth.type === "agent_profile" && provider.auth.tool === "codex") ||
		provider.auth.type === "oauth_profile";
	const acknowledgementId = `remove-provider-ack-${provider.provider_id}`;

	function changeOpen(next: boolean) {
		if (del.isPending) return;
		setOpen(next);
	}

	function removeProvider() {
		del.mutate(
			{ params: { path: { provider_id: provider.provider_id } } },
			{
				onSuccess: () => {
					setOpen(false);
				},
			},
		);
	}

	return (
		<AlertDialog
			open={open}
			onOpenChange={changeOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) setAcknowledged(false);
			}}
		>
			<AlertDialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						className="ml-auto text-muted-foreground hover:text-destructive"
						disabled={del.isPending}
						aria-label={`Remove ${providerLabel}`}
					/>
				}
			>
				<Trash2 />
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove {providerLabel}?</AlertDialogTitle>
					<AlertDialogDescription render={<div className="space-y-2" />}>
						<p>This provider will be removed from your account and cannot be restored.</p>
						{revokesChatGpt ? (
							<p>
								Local access is removed immediately. Upstream ChatGPT revocation may finish
								asynchronously.
							</p>
						) : null}
						<p>{impact.warning}</p>
					</AlertDialogDescription>
				</AlertDialogHeader>
				{impact.acknowledgementRequired ? (
					<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
						<Checkbox
							id={acknowledgementId}
							checked={acknowledged}
							onCheckedChange={(checked) => setAcknowledged(checked === true)}
						/>
						<Label htmlFor={acknowledgementId} className="text-sm font-normal leading-snug">
							I understand that affected agents will lose model access until reconfigured.
						</Label>
					</div>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault();
							removeProvider();
						}}
						disabled={del.isPending || (impact.acknowledgementRequired && !acknowledged)}
						variant="destructive"
					>
						{del.isPending ? <Spinner /> : null}
						Remove provider
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
