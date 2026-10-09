import {
	type EntityBrandIconMetadata,
	type FrameworkBrandIconId,
	frameworkBrandIconMetadata,
	type ProviderBrandIconId,
	providerBrandIconMetadata,
} from "@clawdi/shared/view";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono.js";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Inner.js";
import DeepInfra from "@lobehub/icons/es/DeepInfra/components/Mono.js";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color.js";
import Fireworks from "@lobehub/icons/es/Fireworks/components/Mono.js";
import Gemini from "@lobehub/icons/es/Gemini/components/Color.js";
import Grok from "@lobehub/icons/es/Grok/components/Mono.js";
import Groq from "@lobehub/icons/es/Groq/components/Mono.js";
import HermesAgent from "@lobehub/icons/es/HermesAgent/components/Mono.js";
import HuggingFace from "@lobehub/icons/es/HuggingFace/components/Color.js";
import Kimi from "@lobehub/icons/es/Kimi/components/Color.js";
import Minimax from "@lobehub/icons/es/Minimax/components/Color.js";
import Mistral from "@lobehub/icons/es/Mistral/components/Color.js";
import Nvidia from "@lobehub/icons/es/Nvidia/components/Color.js";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono.js";
import OpenClaw from "@lobehub/icons/es/OpenClaw/components/Color.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Color.js";
import Pi from "@lobehub/icons/es/Pi/components/Mono.js";
import Qwen from "@lobehub/icons/es/Qwen/components/Color.js";
import Stepfun from "@lobehub/icons/es/Stepfun/components/Mono.js";
import Tencent from "@lobehub/icons/es/Tencent/components/Color.js";
import Together from "@lobehub/icons/es/Together/components/Color.js";
import XAI from "@lobehub/icons/es/XAI/components/Mono.js";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo/components/Mono.js";
import ZAI from "@lobehub/icons/es/ZAI/components/Mono.js";
import type { BrandIconComponent } from "@/components/brand-icon-tile";

export type BrandIconMetadata = EntityBrandIconMetadata & { icon: BrandIconComponent };

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
