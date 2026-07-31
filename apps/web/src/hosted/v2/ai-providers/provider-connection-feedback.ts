import type { AiProviderConnectionTestResponse } from "@/hosted/v2/ai-providers/types";

type ConnectionError = NonNullable<AiProviderConnectionTestResponse["error"]>;

const CATEGORY_LABEL: Record<ConnectionError["category"], string> = {
	validation: "Provider setup",
	credential: "Credential",
	ssrf: "Endpoint safety",
	dns: "DNS",
	timeout: "Timeout",
	tls: "TLS",
	network: "Network",
	authentication: "Authentication",
	authorization: "Authorization",
	rate_limit: "Rate limit",
	redirect: "Redirect",
	endpoint: "Endpoint",
	protocol_model: "Protocol or model",
	upstream: "Provider",
};

const CATEGORY_GUIDANCE: Record<ConnectionError["category"], string> = {
	validation: "Review the required provider settings and try again.",
	credential: "Check the API key and try again.",
	ssrf: "This endpoint isn't allowed. Review the Base URL and try again.",
	dns: "The endpoint hostname couldn't be resolved. Check the Base URL and try again.",
	timeout: "The endpoint took too long to respond. Try again in a moment.",
	tls: "The endpoint's secure connection couldn't be verified. Check the Base URL.",
	network: "The provider couldn't be reached. Check the Base URL and try again.",
	authentication: "The provider rejected the API key. Check it and try again.",
	authorization: "This API key doesn't have access to the configured model.",
	rate_limit: "The provider is rate limiting requests. Try again in a moment.",
	redirect: "The endpoint redirected unexpectedly. Check the Base URL.",
	endpoint: "The provider endpoint didn't accept the request. Check the Base URL.",
	protocol_model: "Check the API mode and first configured model, then try again.",
	upstream: "The provider returned an error. Try again in a moment.",
};

export function providerConnectionIssueTitle(error: ConnectionError | null | undefined): string {
	return error ? CATEGORY_LABEL[error.category] : "Connection";
}

export function providerConnectionIssueMessage(error: ConnectionError | null | undefined): string {
	return error
		? CATEGORY_GUIDANCE[error.category]
		: "The provider did not accept the test request.";
}
