import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { BrandIconTile } from "@/components/brand-icon-tile";
import { providerBrandIcon } from "@/components/entity-brand-icons";
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
 *   - framework → official LobeHub React icon
 *   - provider  → official LobeHub React icon in the same neutral tile
 *                 used by monogram fallbacks; ids without an official mark →
 *                 monogram
 *   - anything unresolved → neutral monogram tile
 *
 * Uses plain image rendering — these are tiny/vector brand assets that don't
 * benefit from an optimizer.
 */

const ICON_BASE = "https://assets.clawdi.ai/icons";

/** Channels: full-color app-icon PNGs on Clawdi's CDN. */
const CHANNEL_PNG: Readonly<Record<string, string>> = {
	telegram: `${ICON_BASE}/telegram.png`,
	discord: `${ICON_BASE}/discord.png`,
	whatsapp: `${ICON_BASE}/whatsapp.png`,
	slack: `${ICON_BASE}/slack.png`,
};

const SIZE = {
	sm: { px: 24, box: "size-6 rounded-md", mono: "text-3xs" },
	md: { px: 40, box: "size-10 rounded-lg", mono: "text-sm" },
	lg: { px: 48, box: "size-12 rounded-xl", mono: "text-base" },
} as const;

export type EntityIconSize = keyof typeof SIZE;
export type EntityKind = "channel" | "provider" | "framework";

const SHADOW = "shadow-[0_2px_6px_rgba(0,0,0,0.1)] dark:shadow-none";
const PROVIDER_TILE = "border border-border/60 bg-muted/40 shadow-none";

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
	const providerBrand = kind === "provider" ? providerBrandIcon(key) : undefined;
	const alt = label ?? providerBrand?.label ?? id ?? "";

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

	// Provider brand logo from the official LobeHub React package.
	if (kind === "provider") {
		if (providerBrand) {
			return (
				<BrandIconTile
					icon={providerBrand.icon}
					iconClassName={providerBrand.iconClassName}
					iconScale={providerBrand.iconScale}
					label={alt}
					boxClassName={s.box}
					className={cn(providerBrand.tileClassName, className)}
				/>
			);
		}
		return <NeutralMonogram label={alt} size={size} className={cn(PROVIDER_TILE, className)} />;
	}

	// Neutral fallback for unresolved channels/frameworks.
	return <NeutralMonogram label={alt} size={size} className={className} />;
}
