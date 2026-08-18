import type { SubscriptionSource } from "@/hosted/billing/subscription/subscription-create-adapter";
import type { HostedRuntime } from "@/hosted/runtimes";
import type { AiProviderBindingDraft } from "@/hosted/v2/ai-providers/ai-provider-binding";

export type DeployWizardDirtyState = {
	runtime: HostedRuntime;
	agentName: string;
	compute: "basic" | "performance";
	language: string;
	timezone: string;
	term: number;
	paymentMethod: "card" | "wallet";
	subscriptionSource: SubscriptionSource | null;
	aiBindingDraft: AiProviderBindingDraft;
	checkoutOpen: boolean;
};

function subscriptionSourceEquals(
	left: SubscriptionSource | null,
	right: SubscriptionSource | null,
): boolean {
	if (left?.mode !== right?.mode) return false;
	if (left?.mode !== "existing" || right?.mode !== "existing") return true;
	return left.subscriptionId === right.subscriptionId;
}

function aiBindingEquals(
	current: AiProviderBindingDraft,
	baseline: AiProviderBindingDraft,
): boolean {
	if (
		current.bindingMode !== baseline.bindingMode ||
		current.primaryProviderChoice !== baseline.primaryProviderChoice
	) {
		return false;
	}

	// The managed catalog fills an initially empty model after the first render.
	// Treat that pre-effect value as equivalent to the hydrated default.
	const currentModel = current.primaryModel.trim() || baseline.primaryModel.trim();
	return currentModel === baseline.primaryModel.trim();
}

export function deployWizardDraftIsDirty(
	current: DeployWizardDirtyState,
	baseline: DeployWizardDirtyState,
	committed = false,
): boolean {
	if (committed) return false;
	return (
		current.runtime !== baseline.runtime ||
		current.agentName !== baseline.agentName ||
		current.compute !== baseline.compute ||
		current.language !== baseline.language ||
		current.timezone !== baseline.timezone ||
		current.term !== baseline.term ||
		current.paymentMethod !== baseline.paymentMethod ||
		!subscriptionSourceEquals(current.subscriptionSource, baseline.subscriptionSource) ||
		!aiBindingEquals(current.aiBindingDraft, baseline.aiBindingDraft) ||
		current.checkoutOpen !== baseline.checkoutOpen
	);
}
