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
	"deepseek",
	"gemini",
	"grok",
	"groq",
	"kimi",
	"minimax",
	"mistral",
	"openai",
	"openrouter",
	"qwen",
	"stepfun",
	"together",
	"xai",
	"zai",
] as const;
export type ProviderBrandIconId = (typeof PROVIDER_BRAND_ICON_IDS)[number];
