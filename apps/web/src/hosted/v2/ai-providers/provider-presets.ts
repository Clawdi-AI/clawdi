import { NATIVE_AI_PROVIDERS } from "@clawdi/shared";
import type { ApiMode, ProviderTypeId } from "@/hosted/v2/ai-providers/provider-types";

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
	api_key_url: string;
	region_variants?: readonly ProviderPresetRegionVariant[];
	provider_type: ProviderTypeId;
	runtime_env_name: string;
}

// Display metadata only. Native routing, regions, and protocols have one shared owner.
const PROVIDER_BRANDS = [
	{ id: "deepseek", label: "DeepSeek", api_key_url: "https://platform.deepseek.com/api_keys" },
	{ id: "kimi-coding", label: "Kimi Code", api_key_url: "https://www.kimi.com/code/console" },
	{ id: "moonshot", label: "Kimi API", api_key_url: "https://platform.kimi.com/console/api-keys" },
	{
		id: "qwen-dashscope",
		label: "Qwen (Model Studio)",
		api_key_url: "https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key",
	},
	{
		id: "zhipu-glm",
		label: "Z.AI / Zhipu GLM",
		api_key_url: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
	},
	{ id: "stepfun", label: "StepFun", api_key_url: "https://platform.stepfun.ai/interface-key" },
	{
		id: "minimax",
		label: "MiniMax",
		api_key_url: "https://platform.minimax.io/user-center/basic-information/interface-key",
	},
	{ id: "openrouter", label: "OpenRouter", api_key_url: "https://openrouter.ai/keys" },
	{
		id: "together-ai",
		label: "Together AI",
		api_key_url: "https://api.together.ai/settings/projects/~current/api-keys",
	},
	{ id: "groq", label: "Groq", api_key_url: "https://console.groq.com/keys" },
	{ id: "mistral", label: "Mistral AI", api_key_url: "https://console.mistral.ai/api-keys" },
	{ id: "xai-grok", label: "xAI Grok", api_key_url: "https://console.x.ai/team/default/api-keys" },
] as const;

const REGION_LABELS: Record<string, string> = {
	cn: "China",
	global: "Global",
	"coding-cn": "China · Coding Plan",
	"coding-global": "Global · Coding Plan",
	"plan-cn": "China · Step Plan",
	"plan-global": "Global · Step Plan",
};
const REGION_KEY_URLS: Record<string, string> = {
	"moonshot/global": "https://platform.kimi.ai/console/api-keys",
	"qwen-dashscope/global": "https://bailian.console.alibabacloud.com/?apiKey=1#/api-key",
	"zhipu-glm/global": "https://z.ai/manage-apikey/apikey-list",
	"stepfun/cn": "https://platform.stepfun.com/interface-key",
	"minimax/cn": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = PROVIDER_BRANDS.map((brand) => {
	const routes = NATIVE_AI_PROVIDERS.filter((route) => route.id === brand.id);
	const route = routes[0];
	if (!route) throw new Error(`Missing native provider mapping: ${brand.id}`);
	return {
		...brand,
		base_url: route.base_url,
		api_mode: route.api_mode,
		provider_type: route.type,
		runtime_env_name: route.runtime_env_name,
		region_variants: routes.flatMap((item) =>
			item.variant
				? [
						{
							id: item.variant,
							label: REGION_LABELS[item.variant] ?? item.variant,
							base_url: item.base_url,
							api_key_url:
								REGION_KEY_URLS[`${brand.id}/${item.variant}`] ??
								(/^(coding|plan)-/.test(item.variant) ? "" : brand.api_key_url),
						},
					]
				: [],
		),
	};
});

export type ProviderPresetId = (typeof PROVIDER_BRANDS)[number]["id"];

export function providerPresetById(id: string | null | undefined): ProviderPreset | null {
	return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function providerPresetRegion(
	preset: ProviderPreset,
	regionId: string | null | undefined,
): ProviderPresetRegionVariant | null {
	const regions = preset.region_variants ?? [];
	return regions.find((region) => region.id === regionId) ?? regions[0] ?? null;
}

export function providerPresetForSavedProvider({
	baseUrl,
}: {
	baseUrl: string;
}): ProviderPreset | null {
	const normalized = baseUrl.replace(/\/+$/, "");
	return (
		PROVIDER_PRESETS.find((preset) =>
			[preset.base_url, ...(preset.region_variants ?? []).map((item) => item.base_url)].includes(
				normalized,
			),
		) ?? null
	);
}

export function providerTypeForPreset(preset: ProviderPreset): ProviderTypeId {
	return preset.provider_type;
}

export function presetRuntimeEnvName(preset: ProviderPreset): string {
	return preset.runtime_env_name;
}
