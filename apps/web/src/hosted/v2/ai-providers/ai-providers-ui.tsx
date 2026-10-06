"use client";

import { aiProvidersUiClasses } from "@clawdi/shared/ui";
import { agentSurfaceCopy, providerAuthLabel } from "@clawdi/shared/view";
import { ShieldCheck } from "lucide-react";
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
import { CANONICAL_NAVIGATION_IDENTITIES } from "@/lib/navigation-model";

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
		const Icon = CANONICAL_NAVIGATION_IDENTITIES["ai-providers"].icon;
		return (
			<IconChip size={size} tint={aiProvidersUiClasses.managedTint} className={className}>
				<Icon />
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

/** Auth-method pill for a provider. */
export function AuthBadge({ auth }: { auth: AiProviderAuth }) {
	const label = providerAuthLabel(auth.type);
	return (
		<Badge
			data-hosted="true"
			data-v2="true"
			variant="secondary"
			className={aiProvidersUiClasses.authBadge}
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
						<ShieldCheck className={aiProvidersUiClasses.shield} />
						Default
					</StatusBadge>
				}
				meta={[agentSurfaceCopy.noSetupRequired, agentSurfaceCopy.walletBilled]}
			/>
		</div>
	);
}
