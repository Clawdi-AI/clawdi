import type {
	ApiMode,
	ProviderCatalogModel,
	ProviderTypeId,
} from "@/hosted/v2/ai-providers/provider-types";

// Provider-preset design derived from cc-switch (MIT). Preset data is maintained
// by Clawdi and mapped onto the hosted v2 provider form/API contract.
export interface ProviderPresetCatalogEntry {
	id: string;
	context_window?: number;
	alias?: string;
	cost?: ProviderCatalogModel["cost"];
}

export interface ProviderPresetRegionVariant {
	id: string;
	label: string;
	base_url: string;
	api_key_url?: string;
}

export interface ProviderPreset {
	id: string;
	label: string;
	base_url: string;
	api_mode: ApiMode;
	suggested_primary_model: string;
	catalog: readonly ProviderPresetCatalogEntry[];
	api_key_url: string;
	region_variants?: readonly ProviderPresetRegionVariant[];
	/** Internal backend type to use when the preset matches a first-class type. */
	provider_type?: ProviderTypeId;
}

export const PROVIDER_PRESETS = [
	{
		id: "deepseek",
		label: "DeepSeek",
		base_url: "https://api.deepseek.com/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "deepseek-v4-flash",
		catalog: [
			{ id: "deepseek-v4-flash", context_window: 1_000_000, alias: "DeepSeek V4 Flash" },
			{ id: "deepseek-v4-pro", context_window: 1_000_000, alias: "DeepSeek V4 Pro" },
		],
		api_key_url: "https://platform.deepseek.com/api_keys",
	},
	{
		id: "kimi-coding",
		label: "Kimi Code",
		base_url: "https://api.kimi.com/coding",
		api_mode: "anthropic_messages",
		suggested_primary_model: "kimi-for-coding",
		catalog: [{ id: "kimi-for-coding", context_window: 262_144, alias: "Kimi K2.7 Code" }],
		api_key_url: "https://www.kimi.com/code/console",
		provider_type: "anthropic",
	},
	{
		id: "moonshot",
		label: "Kimi API",
		base_url: "https://api.moonshot.cn/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "kimi-k3",
		catalog: [{ id: "kimi-k3", alias: "Kimi K3" }],
		api_key_url: "https://platform.kimi.com/console/api-keys",
		region_variants: [
			{
				id: "cn",
				label: "China",
				base_url: "https://api.moonshot.cn/v1",
				api_key_url: "https://platform.kimi.com/console/api-keys",
			},
			{
				id: "global",
				label: "Global",
				base_url: "https://api.moonshot.ai/v1",
				api_key_url: "https://platform.kimi.ai/console/api-keys",
			},
		],
	},
	{
		id: "qwen-dashscope",
		label: "Qwen (DashScope)",
		base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "qwen3.7-plus",
		catalog: [
			{ id: "qwen3.7-plus", context_window: 1_000_000, alias: "Qwen3.7 Plus" },
			{ id: "qwen3.7-max", context_window: 1_000_000, alias: "Qwen3.7 Max" },
			{ id: "qwen3-coder-next", context_window: 262_144, alias: "Qwen3 Coder Next" },
		],
		api_key_url: "https://bailian.console.aliyun.com/?tab=model#/api-key",
	},
	{
		id: "zhipu-glm",
		label: "Zhipu GLM",
		base_url: "https://open.bigmodel.cn/api/paas/v4",
		api_mode: "openai_chat",
		suggested_primary_model: "glm-5.2",
		catalog: [
			{ id: "glm-5.2", context_window: 1_000_000, alias: "GLM-5.2" },
			{ id: "glm-5.1", alias: "GLM-5.1" },
			{ id: "glm-4.7", alias: "GLM-4.7" },
		],
		api_key_url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
		region_variants: [
			{
				id: "cn",
				label: "China",
				base_url: "https://open.bigmodel.cn/api/paas/v4",
				api_key_url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
			},
			{
				id: "global",
				label: "Global",
				base_url: "https://api.z.ai/api/paas/v4",
				api_key_url: "https://z.ai/manage-apikey/apikey-list",
			},
		],
	},
	{
		id: "stepfun",
		label: "StepFun",
		base_url: "https://api.stepfun.ai/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "step-3.7-flash",
		catalog: [{ id: "step-3.7-flash", alias: "Step 3.7 Flash" }],
		api_key_url: "https://platform.stepfun.ai/interface-key",
		region_variants: [
			{
				id: "global",
				label: "Global",
				base_url: "https://api.stepfun.ai/v1",
				api_key_url: "https://platform.stepfun.ai/interface-key",
			},
			{
				id: "cn",
				label: "China",
				base_url: "https://api.stepfun.com/v1",
				api_key_url: "https://platform.stepfun.com/interface-key",
			},
		],
	},
	{
		id: "minimax",
		label: "MiniMax",
		base_url: "https://api.minimax.io/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "MiniMax-M3",
		catalog: [
			{ id: "MiniMax-M3", context_window: 1_000_000, alias: "MiniMax M3" },
			{ id: "MiniMax-M2", alias: "MiniMax M2" },
		],
		api_key_url: "https://platform.minimax.io/user-center/basic-information/interface-key",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		base_url: "https://openrouter.ai/api/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "openrouter/auto-beta",
		catalog: [
			{ id: "openrouter/auto-beta", alias: "OpenRouter Auto" },
			{ id: "~openai/gpt-latest", alias: "OpenAI latest" },
			{ id: "anthropic/claude-sonnet-5", context_window: 1_000_000, alias: "Claude Sonnet" },
		],
		api_key_url: "https://openrouter.ai/settings/keys",
		provider_type: "openrouter",
	},
	{
		id: "together-ai",
		label: "Together AI",
		base_url: "https://api.together.ai/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "MiniMaxAI/MiniMax-M3",
		catalog: [
			{ id: "MiniMaxAI/MiniMax-M3", context_window: 524_288, alias: "MiniMax M3" },
			{ id: "zai-org/GLM-5.2", context_window: 262_144, alias: "GLM-5.2" },
		],
		api_key_url: "https://api.together.ai/settings/api-keys",
	},
	{
		id: "groq",
		label: "Groq",
		base_url: "https://api.groq.com/openai/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "openai/gpt-oss-120b",
		catalog: [{ id: "openai/gpt-oss-120b", context_window: 131_072, alias: "GPT OSS 120B" }],
		api_key_url: "https://console.groq.com/keys",
	},
	{
		id: "mistral",
		label: "Mistral AI",
		base_url: "https://api.mistral.ai/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "mistral-large-latest",
		catalog: [
			{ id: "mistral-large-latest", context_window: 256_000, alias: "Mistral Large" },
			{ id: "mistral-medium-latest", context_window: 256_000, alias: "Mistral Medium" },
			{ id: "codestral-latest", context_window: 128_000, alias: "Codestral" },
		],
		api_key_url: "https://console.mistral.ai/api-keys",
		provider_type: "mistral",
	},
	{
		id: "xai-grok",
		label: "xAI Grok",
		base_url: "https://api.x.ai/v1",
		api_mode: "openai_chat",
		suggested_primary_model: "grok-4.5",
		catalog: [{ id: "grok-4.5", context_window: 500_000, alias: "Grok 4.5" }],
		api_key_url: "https://console.x.ai/team/default/api-keys",
	},
	{
		id: "google-gemini-openai",
		label: "Google Gemini (OpenAI-compatible)",
		base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
		api_mode: "openai_chat",
		suggested_primary_model: "gemini-3.5-flash",
		catalog: [
			{ id: "gemini-3.5-flash", context_window: 1_048_576, alias: "Gemini 3.5 Flash" },
			{ id: "gemini-2.5-pro", context_window: 1_048_576, alias: "Gemini 2.5 Pro" },
		],
		api_key_url: "https://aistudio.google.com/apikey",
	},
] as const satisfies readonly ProviderPreset[];

export type ProviderPresetId = (typeof PROVIDER_PRESETS)[number]["id"];

const PROVIDER_PRESET_BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(
	PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

export function providerPresetById(id: string | null | undefined): ProviderPreset | null {
	if (!id) return null;
	return PROVIDER_PRESET_BY_ID.get(id) ?? null;
}

export function providerPresetRegion(
	preset: ProviderPreset,
	regionId: string | null | undefined,
): ProviderPresetRegionVariant | null {
	const regions = preset.region_variants ?? [];
	if (regions.length === 0) return null;
	return regions.find((region) => region.id === regionId) ?? regions[0] ?? null;
}

export function providerPresetForSavedProvider({
	baseUrl,
}: {
	baseUrl: string;
}): ProviderPreset | null {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
	const presets: readonly ProviderPreset[] = PROVIDER_PRESETS;
	return (
		presets.find((preset) => {
			const endpoints = [
				preset.base_url,
				...(preset.region_variants ?? []).map((item) => item.base_url),
			];
			return endpoints.some((endpoint) => endpoint.replace(/\/+$/, "") === normalizedBaseUrl);
		}) ?? null
	);
}

export function providerTypeForPreset(preset: ProviderPreset): ProviderTypeId {
	return preset.provider_type ?? "custom_openai_compatible";
}

export function presetRuntimeEnvName(preset: ProviderPreset): string {
	const name = preset.id
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${name || "PROVIDER"}_API_KEY`;
}

export function presetCatalogToProviderModels(preset: ProviderPreset): ProviderCatalogModel[] {
	return preset.catalog.map((model) => ({
		id: model.id,
		...(model.alias ? { label: model.alias } : {}),
		...(model.alias ? { alias: model.alias } : {}),
		...(model.context_window !== undefined ? { context_window: model.context_window } : {}),
		...(model.cost ? { cost: { ...model.cost } } : {}),
	}));
}
