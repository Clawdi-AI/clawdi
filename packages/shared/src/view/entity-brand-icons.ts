import { entityBrandIconClasses } from "../ui/entity-brand-icons";
import {
	FRAMEWORK_BRAND_ICON_IDS,
	type FrameworkBrandIconId,
	PROVIDER_BRAND_ICON_IDS,
	type ProviderBrandIconId,
} from "./entity-brand-icon-ids";

export type EntityBrandIconMetadata = {
	iconClassName?: string;
	iconScale?: number;
	label: string;
	tileClassName?: string;
};

const FRAMEWORK_BRAND_ICON_DEFINITIONS = {
	openclaw: { iconScale: 0.75, label: "OpenClaw" },
	hermes: {
		// LobeHub's Hermes avatar is intentionally a black mark on white.
		iconClassName: entityBrandIconClasses.blackGlyph,
		iconScale: 0.75,
		label: "Hermes Agent",
		tileClassName: entityBrandIconClasses.whiteTile,
	},
	"claude-code": {
		iconScale: 0.7,
		label: "Claude Code",
	},
	codex: {
		iconScale: 0.7,
		label: "Codex",
		tileClassName: entityBrandIconClasses.whiteTile,
	},
	pi: {
		iconClassName: entityBrandIconClasses.whiteGlyph,
		iconScale: 0.65,
		label: "Pi",
		tileClassName: entityBrandIconClasses.blackTile,
	},
	opencode: {
		iconClassName: entityBrandIconClasses.whiteGlyph,
		iconScale: 0.75,
		label: "OpenCode",
		tileClassName: entityBrandIconClasses.blackTile,
	},
	dsh: { iconScale: 0.75, label: "DeepSeek Harness" },
} satisfies Readonly<Record<FrameworkBrandIconId, EntityBrandIconMetadata>>;

const PROVIDER_BRAND_ICON_DEFINITIONS = {
	anthropic: { label: "Anthropic" },
	deepinfra: { label: "DeepInfra" },
	deepseek: { label: "DeepSeek" },
	fireworks: { label: "Fireworks AI" },
	gemini: { label: "Gemini" },
	grok: { label: "Grok" },
	groq: { label: "Groq" },
	huggingface: { label: "Hugging Face" },
	kimi: { label: "Kimi", tileClassName: entityBrandIconClasses.blackTile },
	minimax: { label: "MiniMax" },
	mistral: { label: "Mistral AI" },
	nvidia: { label: "NVIDIA NIM" },
	openai: { label: "OpenAI" },
	opencode: {
		label: "OpenCode",
		iconClassName: entityBrandIconClasses.whiteGlyph,
		tileClassName: entityBrandIconClasses.blackTile,
	},
	openrouter: { label: "OpenRouter" },
	qwen: { label: "Qwen" },
	stepfun: { label: "StepFun" },
	tencent: { label: "Tencent Cloud" },
	together: { label: "Together AI" },
	xai: { label: "xAI" },
	xiaomi: { label: "Xiaomi MiMo" },
	zai: { label: "Z.ai" },
} satisfies Readonly<Record<ProviderBrandIconId, EntityBrandIconMetadata>>;

const PROVIDER_ICON_ALIASES = new Map<string, ProviderBrandIconId>([
	["alibaba", "qwen"],
	["alibaba-coding-plan", "qwen"],
	["kimi-coding-cn", "kimi"],
	["minimax-cn", "minimax"],
	["openai-api", "openai"],
	["opencode-zen", "opencode"],
	["opencode-go", "opencode"],
	["stepfun-plan", "stepfun"],
	["tencent-tokenhub", "tencent"],
	["tencent-tokenplan", "tencent"],
	["togetherai", "together"],
	["xiaomimimo", "xiaomi"],
	["google-gemini-openai", "gemini"],
	["google", "gemini"],
	["kimi-coding", "kimi"],
	["moonshot", "kimi"],
	["openai-codex", "openai"],
	["qwen-dashscope", "qwen"],
	["together-ai", "together"],
	["xai-grok", "grok"],
	["zhipu-glm", "zai"],
]);

export function frameworkBrandIconMetadata(
	value: string | null | undefined,
): (EntityBrandIconMetadata & { id: FrameworkBrandIconId }) | undefined {
	const key = value?.toLowerCase() ?? "";
	const canonical = key === "claude_code" ? "claude-code" : key;
	const id = FRAMEWORK_BRAND_ICON_IDS.find((id) => id === canonical);
	return id ? { id, ...FRAMEWORK_BRAND_ICON_DEFINITIONS[id] } : undefined;
}

export function providerBrandIconMetadata(
	value: string | null | undefined,
): (EntityBrandIconMetadata & { id: ProviderBrandIconId }) | undefined {
	const key = value?.toLowerCase() ?? "";
	const canonical = PROVIDER_ICON_ALIASES.get(key) ?? key;
	const id = PROVIDER_BRAND_ICON_IDS.find((id) => id === canonical);
	return id ? { id, ...PROVIDER_BRAND_ICON_DEFINITIONS[id] } : undefined;
}
