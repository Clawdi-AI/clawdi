"use client";

import { useState } from "react";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { cn } from "@/lib/utils";

/**
 * One icon for every entity — channels, AI providers, and agent frameworks —
 * so they share identical geometry (rounded tile + subtle shadow) across
 * cards, pickers, lists, and the sidebar.
 *
 * EntityIcon is for real brand/app/framework imagery. Use `IconChip` for
 * abstract Lucide glyphs, resource-color tiles, or object emoji marks.
 *
 * Sources, in resolution order:
 *   - channel   → full-color app-icon PNG on Clawdi's CDN
 *   - framework → local app-icon PNG in /public/agents
 *   - provider  → centralized aliases, labels, and colored brand logos from
 *                 simpleicons (the CDN has no provider PNGs) on a white tile;
 *                 ids without a configured mark → provider-label monogram
 *   - anything unresolved → neutral monogram tile
 *
 * Uses plain image rendering — these are tiny/vector brand assets that don't
 * benefit from an optimizer.
 */

const ICON_BASE = "https://assets.clawdi.ai/icons";
const SIMPLEICON_BASE = "https://cdn.simpleicons.org";

/** Channels: full-color app-icon PNGs on Clawdi's CDN. */
const CHANNEL_PNG: Record<string, string> = {
	telegram: `${ICON_BASE}/telegram.png`,
	discord: `${ICON_BASE}/discord.png`,
	whatsapp: `${ICON_BASE}/whatsapp.png`,
	slack: `${ICON_BASE}/slack.png`,
};

/**
 * AI providers: no CDN PNG (those 404) → colored simpleicons brand logo. The
 * hex is pinned to a vivid, mid-tone brand color so it reads on a white tile
 * in both themes. `null` → neutral monogram (OpenAI isn't in simpleicons;
 * custom endpoints have no brand).
 */
const PROVIDER_SIMPLEICON: Record<string, { slug: string; hex: string } | null> = {
	openai: null,
	anthropic: { slug: "anthropic", hex: "D97757" },
	gemini: { slug: "googlegemini", hex: "1C69FF" },
	google: { slug: "googlegemini", hex: "1C69FF" },
	mistral: { slug: "mistralai", hex: "FA520F" },
	openrouter: { slug: "openrouter", hex: "6566F1" },
	kimi: { slug: "kimi", hex: "000000" },
	custom_openai_compatible: null,
};

const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
	"openai-codex": "openai",
	"kimi-coding": "kimi",
};

const PROVIDER_ICON_LABELS: Readonly<Record<string, string>> = {
	openai: "OpenAI",
	kimi: "Kimi",
};

export function providerIconMetadata(id: string): {
	id: string;
	label: string;
	simpleIcon: { slug: string; hex: string } | null | undefined;
} {
	const key = id.trim().toLowerCase();
	const canonicalId = PROVIDER_ICON_ALIASES[key] ?? key;
	return {
		id: canonicalId,
		label: PROVIDER_ICON_LABELS[canonicalId] ?? id,
		simpleIcon: PROVIDER_SIMPLEICON[canonicalId],
	};
}

const SIZE = {
	sm: { px: 24, box: "size-6 rounded-md", mono: "text-3xs" },
	md: { px: 40, box: "size-10 rounded-lg", mono: "text-sm" },
	lg: { px: 48, box: "size-12 rounded-xl", mono: "text-base" },
} as const;

export type EntityIconSize = keyof typeof SIZE;
export type EntityKind = "channel" | "provider" | "framework";

const SHADOW = "shadow-[0_2px_6px_rgba(0,0,0,0.1)] dark:shadow-none";

function NeutralMonogram({
	label,
	size,
	className,
}: {
	label: string;
	size: EntityIconSize;
	className?: string;
}) {
	const s = SIZE[size];
	const mono = label.trim().charAt(0).toUpperCase() || "?";
	return (
		<span
			aria-hidden
			className={cn(
				s.box,
				"flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground",
				s.mono,
				className,
			)}
		>
			{mono}
		</span>
	);
}

function ProviderBrandIcon({
	src,
	label,
	size,
	className,
}: {
	src: string;
	label: string;
	size: EntityIconSize;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	if (failed) return <NeutralMonogram label={label} size={size} className={className} />;

	const s = SIZE[size];
	return (
		<span
			className={cn(
				s.box,
				"flex shrink-0 items-center justify-center border border-border bg-white",
				SHADOW,
				className,
			)}
		>
			<img
				src={src}
				alt={label}
				width={s.px}
				height={s.px}
				className="size-[60%] object-contain"
				onError={() => setFailed(true)}
			/>
		</span>
	);
}

export function EntityIcon({
	kind,
	id,
	label,
	size = "md",
	className,
}: {
	kind: EntityKind;
	/** Provider type / channel provider / framework agent_type. */
	id: string;
	/** Human label — used for alt text and the fallback monogram. */
	label?: string;
	size?: EntityIconSize;
	className?: string;
}) {
	const s = SIZE[size];
	const key = id?.toLowerCase?.() ?? "";
	const providerMetadata = kind === "provider" ? providerIconMetadata(key) : null;
	const alt = label ?? providerMetadata?.label ?? id ?? "";

	if (kind === "framework") {
		return (
			<AgentFrameworkIcon
				agent={id}
				label={alt}
				alt={alt}
				pixelSize={s.px}
				boxClassName={cn(s.box, SHADOW)}
				fallback="monogram"
				className={cn(s.mono, className)}
			/>
		);
	}

	// Full-color PNG app icon (channels) — fills the rounded tile.
	const png = kind === "channel" ? CHANNEL_PNG[key] : undefined;
	if (png) {
		return (
			<img
				src={png}
				alt={alt}
				width={s.px}
				height={s.px}
				className={cn(s.box, "shrink-0 object-cover", SHADOW, className)}
			/>
		);
	}

	// Provider brand logo (colored simpleicon) on a white tile.
	if (kind === "provider") {
		const brand = providerMetadata?.simpleIcon;
		if (brand) {
			return (
				<ProviderBrandIcon
					key={`${brand.slug}-${brand.hex}`}
					src={`${SIMPLEICON_BASE}/${brand.slug}/${brand.hex}`}
					label={alt}
					size={size}
					className={className}
				/>
			);
		}
	}

	// Neutral fallback: a monogram tile (OpenAI, custom endpoints, unknown ids).
	return <NeutralMonogram label={alt} size={size} className={className} />;
}
