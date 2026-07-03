"use client";

import { ShieldCheck, Sparkles } from "lucide-react";
import { ENTITY_CARD_BASE, EntityHeader } from "@/components/entity-card";
import { EntityIcon, type EntityIconSize } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";
import type { AiProviderAuth } from "@/hosted/v2/ai-providers/types";

/** Real brand-logo icon for a provider type (delegates to the unified EntityIcon). */
export function ProviderTypeChip({
	type,
	size = "md",
	className,
}: {
	type: string;
	size?: EntityIconSize;
	className?: string;
}) {
	const meta = providerTypeMeta(type);
	return (
		<EntityIcon kind="provider" id={type} label={meta.label} size={size} className={className} />
	);
}

const AUTH_LABEL: Record<string, string> = {
	api_key: "API key",
	// Matches the "Sign in with ChatGPT (Codex)" auth option label.
	agent_profile: "ChatGPT",
	oauth_profile: "ChatGPT",
	secret_ref: "Vault key",
	none: "No auth",
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

/** The always-on managed default, no setup. */
export function ManagedProviderCard() {
	return (
		<div data-hosted="true" data-v2="true" className={ENTITY_CARD_BASE}>
			<EntityHeader
				align="start"
				icon={
					<IconChip tint="bg-primary/10 text-primary">
						<Sparkles className="size-5" />
					</IconChip>
				}
				title="Managed by Clawdi"
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
