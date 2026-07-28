/**
 * Web compatibility names for the pure shared Hosted provider projection.
 * Keep React/UI state out of the shared builder and keep deployment payload
 * semantics identical between the dashboard and CLI.
 */

export type {
	HostedAiProviderAuthKind as RuntimeAiProviderAuthKind,
	HostedAiProviderBootstrap as RuntimeAiProviderBootstrap,
} from "@clawdi/shared";
export {
	buildHostedAiProviderPoolBootstrap as buildAiProviderPoolBootstrap,
	hostedAiProviderRuntimeId as aiProviderRuntimeId,
	toHostedRuntimeAiProvider as toRuntimeAiProvider,
} from "@clawdi/shared";
