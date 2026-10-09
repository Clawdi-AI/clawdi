import {
	type EntityBrandIconMetadata,
	type FrameworkBrandIconId,
	frameworkBrandIconMetadata,
	type ProviderBrandIconId,
	providerBrandIconMetadata,
} from "@clawdi/shared/view";
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

type BrandIconMetadata = EntityBrandIconMetadata & { icon: BrandIconComponent };

const FRAMEWORK_BRAND_ICON_COMPONENTS = {
	openclaw: OpenClaw,
	hermes: HermesAgent,
	"claude-code": ClaudeCode,
	codex: Codex,
	pi: Pi,
	opencode: OpenCode,
	dsh: DeepSeek,
} satisfies Readonly<Record<FrameworkBrandIconId, BrandIconComponent>>;

const PROVIDER_BRAND_ICON_COMPONENTS = {
	anthropic: Anthropic,
	deepinfra: DeepInfra,
	deepseek: DeepSeek,
	fireworks: Fireworks,
	gemini: Gemini,
	grok: Grok,
	groq: Groq,
	huggingface: HuggingFace,
	kimi: Kimi,
	minimax: Minimax,
	mistral: Mistral,
	nvidia: Nvidia,
	openai: OpenAI,
	opencode: OpenCode,
	openrouter: OpenRouter,
	qwen: Qwen,
	stepfun: Stepfun,
	tencent: Tencent,
	together: Together,
	xai: XAI,
	xiaomi: XiaomiMiMo,
	zai: ZAI,
} satisfies Readonly<Record<ProviderBrandIconId, BrandIconComponent>>;

export function frameworkBrandIcon(
	value: string | null | undefined,
): BrandIconMetadata | undefined {
	const metadata = frameworkBrandIconMetadata(value);
	if (!metadata) return undefined;
	const { id, ...appearance } = metadata;
	return { ...appearance, icon: FRAMEWORK_BRAND_ICON_COMPONENTS[id] };
}

export function providerBrandIcon(value: string | null | undefined): BrandIconMetadata | undefined {
	const metadata = providerBrandIconMetadata(value);
	if (!metadata) return undefined;
	const { id, ...appearance } = metadata;
	return { ...appearance, icon: PROVIDER_BRAND_ICON_COMPONENTS[id] };
}
