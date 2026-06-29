import Image from "@/lib/image";
import { cn } from "@/lib/utils";

/**
 * One icon for every entity — channels, AI providers, and agent frameworks —
 * so they share identical geometry (rounded tile + subtle shadow) across
 * cards, pickers, lists, and the sidebar.
 *
 * Sources, in resolution order:
 *   - channel   → full-color app-icon PNG on Clawdi's CDN
 *   - framework → local app-icon PNG in /public/agents
 *   - provider  → colored brand logo from simpleicons (the CDN has no
 *                 provider PNGs) on a white tile so the brand color reads in
 *                 both themes; OpenAI / custom have no brand mark → monogram
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
	imessage: `${ICON_BASE}/imessage.png`,
	bluebubbles: `${ICON_BASE}/bluebubbles.png`,
	slack: `${ICON_BASE}/slack.png`,
};

/** Agent frameworks: local app-icon PNGs in /public/agents. */
const FRAMEWORK_PNG: Record<string, string> = {
	openclaw: "/agents/openclaw.png",
	hermes: "/agents/hermes.png",
	"claude-code": "/agents/claude-code.png",
	claude_code: "/agents/claude-code.png",
	codex: "/agents/codex.png",
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
	custom_openai_compatible: null,
};

const SIZE = {
	sm: { px: 24, box: "size-6 rounded-md", mono: "text-[10px]" },
	md: { px: 40, box: "size-10 rounded-lg", mono: "text-sm" },
	lg: { px: 48, box: "size-12 rounded-xl", mono: "text-base" },
} as const;

export type EntityIconSize = keyof typeof SIZE;
export type EntityKind = "channel" | "provider" | "framework";

const SHADOW = "shadow-[0_2px_6px_rgba(0,0,0,0.1)] dark:shadow-none";

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
	const alt = label ?? id ?? "";

	// Full-color PNG app icon (channels, frameworks) — fills the rounded tile.
	const png =
		kind === "channel" ? CHANNEL_PNG[key] : kind === "framework" ? FRAMEWORK_PNG[key] : undefined;
	if (png) {
		return (
			<Image
				src={png}
				alt={alt}
				width={s.px}
				height={s.px}
				unoptimized
				className={cn(s.box, "shrink-0 object-cover", SHADOW, className)}
			/>
		);
	}

	// Provider brand logo (colored simpleicon) on a white tile.
	if (kind === "provider") {
		const brand = PROVIDER_SIMPLEICON[key];
		if (brand) {
			return (
				<span
					className={cn(
						s.box,
						"flex shrink-0 items-center justify-center border border-border bg-white",
						SHADOW,
						className,
					)}
				>
					<Image
						src={`${SIMPLEICON_BASE}/${brand.slug}/${brand.hex}`}
						alt={alt}
						width={s.px}
						height={s.px}
						unoptimized
						className="size-[60%] object-contain"
					/>
				</span>
			);
		}
	}

	// Neutral fallback: a monogram tile (OpenAI, custom endpoints, unknown ids).
	const mono = alt.trim().charAt(0).toUpperCase() || "?";
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
