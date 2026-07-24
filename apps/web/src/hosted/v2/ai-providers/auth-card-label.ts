import type { AiProviderAuthKind } from "@/hosted/billing/contracts";
import { MANAGED_PROVIDER_LABEL } from "@/hosted/v2/ai-providers/model-binding";

export function authCardLabel(authKind: AiProviderAuthKind): string {
	switch (authKind) {
		case "unmanaged":
			return "Configure inside agent";
		case "api_key":
			return "Use your own API key";
		case "codex_oauth":
			return "Use your OpenAI account";
		default:
			return MANAGED_PROVIDER_LABEL;
	}
}
