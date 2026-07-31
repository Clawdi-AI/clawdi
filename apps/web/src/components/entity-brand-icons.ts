import {
	Anthropic,
	ClaudeCode,
	Codex,
	DeepSeek,
	Gemini,
	Grok,
	Groq,
	HermesAgent,
	Kimi,
	Minimax,
	Mistral,
	OpenAI,
	OpenClaw,
	OpenRouter,
	Qwen,
	Stepfun,
	Together,
	XAI,
	Zhipu,
} from "@lobehub/icons";
import type { BrandIconComponent } from "@/components/brand-icon-tile";

export type BrandIconMetadata = {
	icon: BrandIconComponent;
	label: string;
};

const FRAMEWORK_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> = {
	openclaw: { icon: OpenClaw.Color, label: "OpenClaw" },
	hermes: { icon: HermesAgent, label: "Hermes Agent" },
	"claude-code": { icon: ClaudeCode.Color, label: "Claude Code" },
	claude_code: { icon: ClaudeCode.Color, label: "Claude Code" },
	codex: { icon: Codex.Color, label: "Codex" },
};

const PROVIDER_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> = {
	anthropic: { icon: Anthropic, label: "Anthropic" },
	deepseek: { icon: DeepSeek.Color, label: "DeepSeek" },
	gemini: { icon: Gemini.Color, label: "Gemini" },
	grok: { icon: Grok, label: "Grok" },
	groq: { icon: Groq, label: "Groq" },
	kimi: { icon: Kimi.Color, label: "Kimi" },
	minimax: { icon: Minimax.Color, label: "MiniMax" },
	mistral: { icon: Mistral.Color, label: "Mistral AI" },
	openai: { icon: OpenAI, label: "OpenAI" },
	openrouter: { icon: OpenRouter.Color, label: "OpenRouter" },
	qwen: { icon: Qwen.Color, label: "Qwen" },
	stepfun: { icon: Stepfun, label: "StepFun" },
	together: { icon: Together.Color, label: "Together AI" },
	xai: { icon: XAI, label: "xAI" },
	zhipu: { icon: Zhipu.Color, label: "Zhipu" },
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

export function frameworkBrandIcon(id: string | null | undefined): BrandIconMetadata | undefined {
	return FRAMEWORK_BRAND_ICONS[id?.toLowerCase() ?? ""];
}

export function providerBrandIcon(id: string | null | undefined): BrandIconMetadata | undefined {
	const key = id?.toLowerCase() ?? "";
	return PROVIDER_BRAND_ICONS[PROVIDER_ICON_ALIASES[key] ?? key];
}
