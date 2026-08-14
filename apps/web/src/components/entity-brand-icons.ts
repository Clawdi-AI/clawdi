import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono.js";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Inner.js";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color.js";
import Gemini from "@lobehub/icons/es/Gemini/components/Color.js";
import Grok from "@lobehub/icons/es/Grok/components/Mono.js";
import Groq from "@lobehub/icons/es/Groq/components/Mono.js";
import HermesAgent from "@lobehub/icons/es/HermesAgent/components/Mono.js";
import Kimi from "@lobehub/icons/es/Kimi/components/Color.js";
import Minimax from "@lobehub/icons/es/Minimax/components/Color.js";
import Mistral from "@lobehub/icons/es/Mistral/components/Color.js";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono.js";
import OpenClaw from "@lobehub/icons/es/OpenClaw/components/Color.js";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Color.js";
import Qwen from "@lobehub/icons/es/Qwen/components/Color.js";
import Stepfun from "@lobehub/icons/es/Stepfun/components/Mono.js";
import Together from "@lobehub/icons/es/Together/components/Color.js";
import XAI from "@lobehub/icons/es/XAI/components/Mono.js";
import ZAI from "@lobehub/icons/es/ZAI/components/Mono.js";
import type { BrandIconComponent } from "@/components/brand-icon-tile";
import type { FrameworkBrandIconId, ProviderBrandIconId } from "@/components/entity-brand-icon-ids";

export type BrandIconMetadata = {
	icon: BrandIconComponent;
	iconClassName?: string;
	iconScale?: number;
	label: string;
	tileClassName?: string;
};

const FRAMEWORK_BRAND_ICON_DEFINITIONS = {
	openclaw: { icon: OpenClaw, iconScale: 0.75, label: "OpenClaw" },
	hermes: {
		icon: HermesAgent,
		// LobeHub's Hermes avatar is intentionally a black mark on white.
		iconClassName: "text-black",
		iconScale: 0.75,
		label: "Hermes Agent",
		tileClassName: "bg-white",
	},
	"claude-code": {
		icon: ClaudeCode,
		iconScale: 0.7,
		label: "Claude Code",
	},
	codex: { icon: Codex, iconScale: 0.7, label: "Codex", tileClassName: "bg-white" },
} satisfies Readonly<Record<FrameworkBrandIconId, BrandIconMetadata>>;

const FRAMEWORK_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> = {
	...FRAMEWORK_BRAND_ICON_DEFINITIONS,
	claude_code: FRAMEWORK_BRAND_ICON_DEFINITIONS["claude-code"],
};

const PROVIDER_BRAND_ICON_DEFINITIONS = {
	anthropic: { icon: Anthropic, label: "Anthropic" },
	deepseek: { icon: DeepSeek, label: "DeepSeek" },
	gemini: { icon: Gemini, label: "Gemini" },
	grok: { icon: Grok, label: "Grok" },
	groq: { icon: Groq, label: "Groq" },
	kimi: { icon: Kimi, label: "Kimi", tileClassName: "bg-black" },
	minimax: { icon: Minimax, label: "MiniMax" },
	mistral: { icon: Mistral, label: "Mistral AI" },
	openai: { icon: OpenAI, label: "OpenAI" },
	openrouter: { icon: OpenRouter, label: "OpenRouter" },
	qwen: { icon: Qwen, label: "Qwen" },
	stepfun: { icon: Stepfun, label: "StepFun" },
	together: { icon: Together, label: "Together AI" },
	xai: { icon: XAI, label: "xAI" },
	zai: { icon: ZAI, label: "Z.ai" },
} satisfies Readonly<Record<ProviderBrandIconId, BrandIconMetadata>>;

const PROVIDER_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> =
	PROVIDER_BRAND_ICON_DEFINITIONS;

const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
	"google-gemini-openai": "gemini",
	google: "gemini",
	"kimi-coding": "kimi",
	moonshot: "kimi",
	"openai-codex": "openai",
	"qwen-dashscope": "qwen",
	"together-ai": "together",
	"xai-grok": "grok",
	"zhipu-glm": "zai",
};

export function frameworkBrandIcon(id: string | null | undefined): BrandIconMetadata | undefined {
	return FRAMEWORK_BRAND_ICONS[id?.toLowerCase() ?? ""];
}

export function providerBrandIcon(id: string | null | undefined): BrandIconMetadata | undefined {
	const key = id?.toLowerCase() ?? "";
	return PROVIDER_BRAND_ICONS[PROVIDER_ICON_ALIASES[key] ?? key];
}
