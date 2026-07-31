import {
	CODEX_OAUTH_MODEL_CATALOG,
	defaultAiProviderBaseUrl,
	defaultAiProviderModels,
} from "@clawdi/shared";
import { toProviderCatalogModels } from "@/hosted/v2/ai-providers/provider-types";
import type { AiProviderUpsert } from "@/hosted/v2/ai-providers/types";

export const CLAWDI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";

/** Catalog seed for a fresh Codex provider (OpenAI Responses / GPT-5). */
export const CODEX_DEFAULT_MODEL =
	CODEX_OAUTH_MODEL_CATALOG[0]?.id ?? defaultAiProviderModels("openai")[0]?.id;

/** Canonical provider accepted by the ChatGPT device-code flow. */
export function codexProviderBody(): AiProviderUpsert {
	return {
		provider_id: CLAWDI_CODEX_OAUTH_PROVIDER_ID,
		type: "openai",
		label: "Codex (ChatGPT)",
		base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
		models: toProviderCatalogModels(CODEX_OAUTH_MODEL_CATALOG),
		api_mode: "openai_responses",
		auth: { type: "agent_profile", tool: "codex", profile: "default" },
		managed_by: "user",
		runtime_env_name: null,
	};
}
