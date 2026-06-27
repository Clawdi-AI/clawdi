"use client";

import { BadgeCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Skeleton } from "@/components/ui/skeleton";
import { formatModelLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AddProviderDialog } from "@/v2/ai-providers/add-provider-dialog";
import {
	useAiProviders,
	useDeleteProvider,
	useValidateProvider,
} from "@/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ManagedProviderCard } from "@/v2/ai-providers/ai-providers-ui";
import { API_MODE_LABEL, type ApiMode, providerTypeMeta } from "@/v2/ai-providers/provider-types";
import type { AiProvider } from "@/v2/ai-providers/types";
import { ChannelError } from "@/v2/channels/channel-ui";

const DESCRIPTION = "Choose how your agents reach a model.";

export function AiProvidersPage() {
	const providers = useAiProviders();
	const [addOpen, setAddOpen] = useState(false);
	const [editing, setEditing] = useState<AiProvider | null>(null);

	const list = providers.data?.providers ?? [];

	return (
		<div data-v2="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Model Providers"
				description={DESCRIPTION}
				actions={
					<Button
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

			<ManagedProviderCard />

			<div className="space-y-2">
				<div className="px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Your providers
				</div>
				{providers.error ? (
					<ChannelError
						error={providers.error}
						onRetry={() => providers.refetch()}
						title="Couldn’t load providers"
					/>
				) : providers.isLoading ? (
					<div className="space-y-2">
						{[0, 1].map((i) => (
							<Skeleton key={i} className="h-24 w-full rounded-lg" />
						))}
					</div>
				) : list.length === 0 ? (
					<EmptyState
						title="No custom providers"
						description="Add your own OpenAI, Anthropic, OpenRouter, Gemini, Mistral, or a custom OpenAI-compatible endpoint."
						fillHeight={false}
					/>
				) : (
					<div className="space-y-2">
						{list.map((provider) => (
							<ProviderCard
								key={provider.provider_id}
								provider={provider}
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

function ProviderCard({ provider, onEdit }: { provider: AiProvider; onEdit: () => void }) {
	const meta = providerTypeMeta(provider.type);
	const del = useDeleteProvider();
	const validate = useValidateProvider();

	function runValidate() {
		validate.mutate(provider.provider_id, {
			onSuccess: (result) => {
				if (result.valid) toast.success("Configuration looks good");
				else toast.warning("Validation issues", { description: result.errors.join(" · ") });
			},
		});
	}

	return (
		<div className={cn(ENTITY_CARD_BASE, "bg-card")}>
			<EntityHeader
				align="start"
				icon={
					<EntityIcon
						kind="provider"
						id={provider.type}
						label={provider.label ?? provider.provider_id}
					/>
				}
				title={provider.label ?? provider.provider_id}
				titleAdornment={<AuthBadge auth={provider.auth} />}
				meta={[
					`${meta.label}${provider.default_model ? ` · ${formatModelLabel(provider.default_model)}` : ""}${
						provider.api_mode
							? ` · ${API_MODE_LABEL[provider.api_mode as ApiMode] ?? provider.api_mode}`
							: ""
					}`,
					<span key="base" className="font-mono">
						{provider.base_url}
						{provider.runtime_env_name ? ` · ${provider.runtime_env_name}` : ""}
					</span>,
				]}
			/>
			<div className="mt-3 flex flex-wrap justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={runValidate} disabled={validate.isPending}>
					<BadgeCheck className="size-3.5" />
					Validate
				</Button>
				<Button variant="outline" size="sm" onClick={onEdit}>
					<Pencil className="size-3.5" />
					Edit
				</Button>
				<ConfirmAction
					title={`Remove ${provider.label ?? provider.provider_id}?`}
					description={
						<p>
							Agents using this provider fall back to the managed default. This can't be undone.
						</p>
					}
					confirmLabel="Remove provider"
					destructive
					onConfirm={() => del.mutate(provider.provider_id)}
				>
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground hover:text-destructive"
						disabled={del.isPending}
					>
						<Trash2 className="size-3.5" />
						Remove
					</Button>
				</ConfirmAction>
			</div>
		</div>
	);
}
