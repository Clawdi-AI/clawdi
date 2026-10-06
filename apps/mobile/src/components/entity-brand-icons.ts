import { entityBrandIconClasses } from "@clawdi/shared/ui";
import { createBrandIcon } from "@/components/brand-icon-tile";
import { brandAssets } from "@/platform/brand-assets.generated";

const Anthropic = createBrandIcon(brandAssets.Anthropic);
const ClaudeCode = createBrandIcon(brandAssets.ClaudeCode);
const Codex = createBrandIcon(brandAssets.Codex);
const DeepInfra = createBrandIcon(brandAssets.DeepInfra);
const DeepSeek = createBrandIcon(brandAssets.DeepSeek);
const Fireworks = createBrandIcon(brandAssets.Fireworks);
const Gemini = createBrandIcon(brandAssets.Gemini);
const Grok = createBrandIcon(brandAssets.Grok);
const Groq = createBrandIcon(brandAssets.Groq);
const HermesAgent = createBrandIcon(brandAssets.HermesAgent);
const HuggingFace = createBrandIcon(brandAssets.HuggingFace);
const Kimi = createBrandIcon(brandAssets.Kimi);
const Minimax = createBrandIcon(brandAssets.Minimax);
const Mistral = createBrandIcon(brandAssets.Mistral);
const Nvidia = createBrandIcon(brandAssets.Nvidia);
const OpenAI = createBrandIcon(brandAssets.OpenAI);
const OpenClaw = createBrandIcon(brandAssets.OpenClaw);
const OpenCode = createBrandIcon(brandAssets.OpenCode);
const OpenRouter = createBrandIcon(brandAssets.OpenRouter);
const Pi = createBrandIcon(brandAssets.Pi);
const Qwen = createBrandIcon(brandAssets.Qwen);
const Stepfun = createBrandIcon(brandAssets.Stepfun);
const Tencent = createBrandIcon(brandAssets.Tencent);
const Together = createBrandIcon(brandAssets.Together);
const XAI = createBrandIcon(brandAssets.XAI);
const XiaomiMiMo = createBrandIcon(brandAssets.XiaomiMiMo);
const ZAI = createBrandIcon(brandAssets.ZAI);

import type { BrandIconComponent } from "@/components/brand-icon-tile";
import type { FrameworkBrandIconId, ProviderBrandIconId } from "@/lib/entity-brand-icon-ids";

type BrandIconMetadata = {
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
		iconClassName: entityBrandIconClasses.blackGlyph,
		iconScale: 0.75,
		label: "Hermes Agent",
		tileClassName: entityBrandIconClasses.whiteTile,
	},
	"claude-code": {
		icon: ClaudeCode,
		iconScale: 0.7,
		label: "Claude Code",
	},
	codex: {
		icon: Codex,
		iconScale: 0.7,
		label: "Codex",
		tileClassName: entityBrandIconClasses.whiteTile,
	},
	pi: {
		icon: Pi,
		iconClassName: entityBrandIconClasses.whiteGlyph,
		iconScale: 0.65,
		label: "Pi",
		tileClassName: entityBrandIconClasses.blackTile,
	},
	opencode: {
		icon: OpenCode,
		iconClassName: entityBrandIconClasses.whiteGlyph,
		iconScale: 0.75,
		label: "OpenCode",
		tileClassName: entityBrandIconClasses.blackTile,
	},
	dsh: { icon: DeepSeek, iconScale: 0.75, label: "DeepSeek Harness" },
} satisfies Readonly<Record<FrameworkBrandIconId, BrandIconMetadata>>;

const FRAMEWORK_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> = {
	...FRAMEWORK_BRAND_ICON_DEFINITIONS,
	claude_code: FRAMEWORK_BRAND_ICON_DEFINITIONS["claude-code"],
};

const PROVIDER_BRAND_ICON_DEFINITIONS = {
	anthropic: { icon: Anthropic, label: "Anthropic" },
	deepinfra: { icon: DeepInfra, label: "DeepInfra" },
	deepseek: { icon: DeepSeek, label: "DeepSeek" },
	fireworks: { icon: Fireworks, label: "Fireworks AI" },
	gemini: { icon: Gemini, label: "Gemini" },
	grok: { icon: Grok, label: "Grok" },
	groq: { icon: Groq, label: "Groq" },
	huggingface: { icon: HuggingFace, label: "Hugging Face" },
	kimi: { icon: Kimi, label: "Kimi", tileClassName: entityBrandIconClasses.blackTile },
	minimax: { icon: Minimax, label: "MiniMax" },
	mistral: { icon: Mistral, label: "Mistral AI" },
	nvidia: { icon: Nvidia, label: "NVIDIA NIM" },
	openai: { icon: OpenAI, label: "OpenAI" },
	opencode: {
		icon: OpenCode,
		label: "OpenCode",
		iconClassName: entityBrandIconClasses.whiteGlyph,
		tileClassName: entityBrandIconClasses.blackTile,
	},
	openrouter: { icon: OpenRouter, label: "OpenRouter" },
	qwen: { icon: Qwen, label: "Qwen" },
	stepfun: { icon: Stepfun, label: "StepFun" },
	tencent: { icon: Tencent, label: "Tencent Cloud" },
	together: { icon: Together, label: "Together AI" },
	xai: { icon: XAI, label: "xAI" },
	xiaomi: { icon: XiaomiMiMo, label: "Xiaomi MiMo" },
	zai: { icon: ZAI, label: "Z.ai" },
} satisfies Readonly<Record<ProviderBrandIconId, BrandIconMetadata>>;

const PROVIDER_BRAND_ICONS: Readonly<Record<string, BrandIconMetadata>> =
	PROVIDER_BRAND_ICON_DEFINITIONS;

const PROVIDER_ICON_ALIASES: Readonly<Record<string, ProviderBrandIconId>> = {
	alibaba: "qwen",
	"alibaba-coding-plan": "qwen",
	"kimi-coding-cn": "kimi",
	"minimax-cn": "minimax",
	"openai-api": "openai",
	"opencode-zen": "opencode",
	"opencode-go": "opencode",
	"stepfun-plan": "stepfun",
	"tencent-tokenhub": "tencent",
	"tencent-tokenplan": "tencent",
	togetherai: "together",
	xiaomimimo: "xiaomi",
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
