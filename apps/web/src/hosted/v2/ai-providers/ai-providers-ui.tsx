"use client";

import { ShieldCheck, Sparkles } from "lucide-react";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon, type EntityIconSize } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	providerPresentation,
} from "@/hosted/v2/ai-providers/model-binding";
import type { AiProvider, AiProviderAuth } from "@/hosted/v2/ai-providers/types";

/** Brand-preserving icon for a saved provider or provider reference. */
export function ProviderIcon({
	provider,
	providers = [],
	size = "md",
	className,
}: {
	provider: AiProvider | string;
	providers?: readonly AiProvider[];
	size?: EntityIconSize;
	className?: string;
}) {
	const presentation = providerPresentation(provider, providers);
	if (presentation.managed) {
		return (
			<IconChip size={size} tint="bg-primary/10 text-primary" className={className}>
				<Sparkles />
			</IconChip>
		);
	}
	return (
		<EntityIcon
			kind="provider"
			id={presentation.iconId}
			label={presentation.brandLabel}
			size={size}
			className={className}
		/>
	);
}

const AUTH_LABEL: Record<string, string> = {
	api_key: "API key",
	agent_profile: "ChatGPT",
	oauth_profile: "ChatGPT",
	secret_ref: "Vault key",
	none: "No credential",
};

/** Auth-method pill for a provider. */
export function AuthBadge({ auth }: { auth: AiProviderAuth }) {
	const label = AUTH_LABEL[auth.type] ?? auth.type;
	return (
		<Badge
			data-hosted="true"
			data-v2="true"
			variant="secondary"
			className="px-2 py-0.5 text-2xs text-muted-foreground"
		>
			{label}
		</Badge>
	);
}

export function ProviderReadinessBadge({ deployable }: { deployable: boolean }) {
	return (
		<StatusBadge status={deployable ? "success" : "warning"} withDot>
			{deployable ? "Ready" : "Setup required"}
		</StatusBadge>
	);
}

/** The always-on managed default, no setup. */
export function ManagedProviderCard() {
	return (
		<div data-hosted="true" data-v2="true" className={ENTITY_CARD_BASE}>
			<EntityHeader
				align="start"
				icon={<ProviderIcon provider={MANAGED_PROVIDER_ID} />}
				title={MANAGED_PROVIDER_LABEL}
				titleAdornment={
					<StatusBadge status="success">
						<ShieldCheck className="size-3" />
						Default
					</StatusBadge>
				}
				meta={["No setup required", "Wallet billed"]}
			/>
		</div>
	);
}
