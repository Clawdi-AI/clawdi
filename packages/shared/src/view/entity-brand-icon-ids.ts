export const FRAMEWORK_BRAND_ICON_IDS = [
	"openclaw",
	"hermes",
	"claude-code",
	"codex",
	"pi",
	"opencode",
] as const;
export type FrameworkBrandIconId = (typeof FRAMEWORK_BRAND_ICON_IDS)[number];

export const PROVIDER_BRAND_ICON_IDS = [
	"anthropic",
	"deepinfra",
	"deepseek",
	"fireworks",
	"gemini",
	"grok",
	"groq",
	"huggingface",
	"kimi",
	"minimax",
	"mistral",
	"nvidia",
	"openai",
	"opencode",
	"openrouter",
	"qwen",
	"stepfun",
	"tencent",
	"together",
	"xai",
	"xiaomi",
	"zai",
] as const;
export type ProviderBrandIconId = (typeof PROVIDER_BRAND_ICON_IDS)[number];
