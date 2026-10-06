import { defaultAiProviderBaseUrl } from "../ai-provider";
import type { components } from "./api.generated";

type AiProviderUpsert = components["schemas"]["AiProviderUpsert"];

/** Provider accepted by one independent ChatGPT device-code flow. */
export function codexProviderBody(identity: {
	providerId: string;
	label: string | null;
}): AiProviderUpsert {
	return {
		provider_id: identity.providerId,
		type: "openai",
		label: identity.label,
		base_url: defaultAiProviderBaseUrl("openai") ?? "https://api.openai.com/v1",
		configuration_mode: "native",
		native_provider: "openai-codex",
		native_variant: null,
		api_mode: "openai_responses",
		auth: { type: "agent_profile", tool: "codex", profile: "default" },
		managed_by: "user",
		runtime_env_name: null,
	};
}

/** Only the device verification page emitted by the Cloud service may open externally. */
export function codexDeviceVerificationUrl(value: string): string {
	const url = new URL(value);
	if (
		url.origin !== "https://auth.openai.com" ||
		url.pathname !== "/codex/device" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid device verification URL");
	return url.href;
}

export function devicePollDelay(seconds: number): number {
	if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
		throw new Error("Invalid poll interval");
	return Math.max(seconds, 1) * 1000;
}
