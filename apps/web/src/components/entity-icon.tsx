"use client";

import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import deepSeekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import grokIcon from "@lobehub/icons-static-svg/icons/grok.svg";
import groqIcon from "@lobehub/icons-static-svg/icons/groq.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi.svg";
import miniMaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import stepFunIcon from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import togetherAiIcon from "@lobehub/icons-static-svg/icons/together-color.svg";
import xAiIcon from "@lobehub/icons-static-svg/icons/xai.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
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
 *   - provider  → official package-local LobeHub SVG in the same neutral tile
 *                 used by monogram fallbacks; ids without an official mark →
 *                 monogram
 *   - anything unresolved → neutral monogram tile
 *
 * Uses plain image rendering — these are tiny/vector brand assets that don't
 * benefit from an optimizer.
 */

const ICON_BASE = "https://assets.clawdi.ai/icons";

/** Channels: full-color app-icon PNGs on Clawdi's CDN. */
const CHANNEL_PNG: Record<string, string> = {
	telegram: `${ICON_BASE}/telegram.png`,
	discord: `${ICON_BASE}/discord.png`,
	whatsapp: `${ICON_BASE}/whatsapp.png`,
	slack: `${ICON_BASE}/slack.png`,
};

type ProviderBrandIconMetadata = {
	label: string;
	monochrome?: boolean;
	src: string;
};

/** Official LobeHub assets for every branded provider currently offered by the web app. */
const PROVIDER_BRAND_ICONS: Readonly<Record<string, ProviderBrandIconMetadata>> = {
	anthropic: { label: "Anthropic", monochrome: true, src: anthropicIcon },
	deepseek: { label: "DeepSeek", src: deepSeekIcon },
	gemini: { label: "Gemini", src: geminiIcon },
	grok: { label: "Grok", monochrome: true, src: grokIcon },
	groq: { label: "Groq", monochrome: true, src: groqIcon },
	kimi: { label: "Kimi", monochrome: true, src: kimiIcon },
	minimax: { label: "MiniMax", src: miniMaxIcon },
	mistral: { label: "Mistral AI", src: mistralIcon },
	openai: { label: "OpenAI", monochrome: true, src: openAiIcon },
	openrouter: { label: "OpenRouter", src: openRouterIcon },
	qwen: { label: "Qwen", src: qwenIcon },
	stepfun: { label: "StepFun", src: stepFunIcon },
	together: { label: "Together AI", src: togetherAiIcon },
	xai: { label: "xAI", monochrome: true, src: xAiIcon },
	zhipu: { label: "Zhipu", src: zhipuIcon },
};

const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
	"google-gemini-openai": "gemini",
	google: "gemini",
	"kimi-coding": "kimi",
	moonshot: "kimi",
	"openai-codex": "openai",
	"qwen-dashscope": "qwen",
	"together-ai": "together",
	"xai-grok": "grok",
	"zhipu-glm": "zhipu",
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

function ProviderBrandIcon({
	src,
	label,
	monochrome,
	size,
	className,
}: {
	src: string;
	label: string;
	monochrome?: boolean;
	size: EntityIconSize;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	if (failed) {
		return <NeutralMonogram label={label} size={size} className={cn(PROVIDER_TILE, className)} />;
	}

	const s = SIZE[size];
	return (
		<span
			className={cn(s.box, "flex shrink-0 items-center justify-center", PROVIDER_TILE, className)}
		>
			<img
				src={src}
				alt={label}
				width={s.px}
				height={s.px}
				className={cn("size-[60%] object-contain", monochrome && "dark:invert")}
				data-icon-source="lobehub"
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
	const providerBrand =
		kind === "provider" ? PROVIDER_BRAND_ICONS[PROVIDER_ICON_ALIASES[key] ?? key] : undefined;
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

	// Provider brand logo from the package-local official LobeHub asset set.
	if (kind === "provider") {
		if (providerBrand) {
			return (
				<ProviderBrandIcon
					key={providerBrand.src}
					src={providerBrand.src}
					label={alt}
					monochrome={providerBrand.monochrome}
					size={size}
					className={className}
				/>
			);
		}
		return <NeutralMonogram label={alt} size={size} className={cn(PROVIDER_TILE, className)} />;
	}

	// Neutral fallback for unresolved channels/frameworks.
	return <NeutralMonogram label={alt} size={size} className={className} />;
}
