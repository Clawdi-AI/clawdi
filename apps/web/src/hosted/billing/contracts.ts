import type { DeployComponents } from "@clawdi/shared/api";

type Schemas = DeployComponents["schemas"];

export const COMPUTE_BASIC_SLUG = "compute_basic" as const;
export const COMPUTE_PERFORMANCE_SLUG = "compute_performance" as const;

export type AiProviderAuthKind = NonNullable<
	Schemas["V2HostedDeployRequest"]["ai_provider_auth_kind"]
>;
export type BillingOffer = Schemas["V2BillingOfferResponse"];
export type CheckoutRequest = Schemas["V2ComputeCheckoutRequest"];
export type ComputePlanSlug = Schemas["V2HostedDeployRequest"]["compute_plan_slug"];
export type ComputeSubscriptionActionResult = Schemas["V2ComputeSubscriptionActionResponse"];
export type ComputeSubscriptionCancelRequest = Schemas["V2ComputeSubscriptionCancelRequest"];
export type ComputeSubscriptionListItem = Schemas["V2ComputeSubscriptionListItem"];
export type ComputeFixPaymentRequest = Schemas["V2ComputeFixPaymentRequest"];
export type ComputePlanChangeRequest = Schemas["V2ComputePlanChangeRequest"];
export type ComputePlanChangeProgress = Schemas["ComputePlanChangeProgress"];
export type ComputePlanChangeKind = ComputePlanChangeProgress["changeKind"];
export type ComputePlanChangeBillingEffect = ComputePlanChangeProgress["billingEffect"];
export type ComputePlanChangeFundingSource = ComputePlanChangeProgress["fundingSource"];
export type ComputePlanChangeResult = {
	kind: Extract<ComputePlanChangeProgress["state"], "complete" | "scheduled">;
	operationName: string;
	effectiveAt: string;
	changeKind: ComputePlanChangeKind;
	billingEffect: ComputePlanChangeBillingEffect;
	fundingSource: ComputePlanChangeFundingSource;
};
export type ComputePlanChangeQuoteRequest = Schemas["V2ComputePlanChangeQuoteRequest"];
export type ComputePlanChangeQuoteResponse = Schemas["V2ComputePlanChangeQuoteResponse"];
export type ComputeSubscriptionQuoteRequest = Schemas["V2ComputeSubscriptionQuoteRequest"];
export type ComputeSubscriptionQuoteResponse = Schemas["V2ComputeSubscriptionQuoteResponse-Output"];
export type ReusableSubscription = Schemas["V2ComputeReusableSubscriptionItem"];
export type ReusableSubscriptionsResponse = Schemas["V2ComputeReusableSubscriptionsResponse"];
export type ComputeSubscriptionResumeRequest = Schemas["V2ComputeSubscriptionResumeRequest"];
export type DeploymentCreateRequest = Schemas["V2HostedDeployRequest"];
export type DeploymentDeleteConvergedResponse = Schemas["V2DeleteDeploymentConvergedResponse"];
export type DeploymentDeleteRequest = Schemas["V2DeleteDeploymentRequest"];
export type DeploymentUpdateRequest = Schemas["V2UpdateDeploymentRequest"];
export type SubscriptionSelection = NonNullable<CheckoutRequest["subscription_selection"]>;
export type DeploymentDesiredLifecycle = "running" | "stopped";
export type DeployRequest = Schemas["V2HostedDeployRequest"];
export type HostedDeploymentSpec = Schemas["HostedDeploymentSpec"];
export type HostedDeploymentStatus = Schemas["HostedDeploymentStatus"];
export type DeploymentOperation = Schemas["LongRunningOperation"];
export type HostedDeployment = Schemas["V2HostedDeploymentReadResponse"];
export type HostedComputeSubscription = NonNullable<
	NonNullable<HostedDeployment["commercial_display"]>["compute_subscription"]
>;
export type HostedDeployRequestStatus = Schemas["V2HostedDeployRequestReadResponse"];
export type HostedEventStreamSnapshotHandoff = Schemas["EventStreamSnapshotHandoff"];
export type HostedFundingFact = Schemas["V2HostedCommercialFundingFactInfo"];
export type HostedUsageSummary = Schemas["V2HostedUsageSummaryResponse"];
export type HostedRuntimeConfiguration = Schemas["RuntimeConfiguration"];
export type HostedWorkspaceSkillDesiredItem = Schemas["V2WorkspaceSkillDesiredItem"];
export type HostedWorkspaceSkillInstallRequest = Schemas["V2WorkspaceSkillInstallRequest"];
export type HostedWorkspaceSkillListResponse = Schemas["V2WorkspaceSkillListResponse"];
export type HostedWorkspaceSkillMutationResponse = Schemas["V2WorkspaceSkillMutationResponse"];
export type ManagedModelCatalogItem = Schemas["V2ManagedModelCatalogItem"];
export type HostedUser = Schemas["V1UserResponse"];
export type HostedConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type WalletAutoReloadAction = Schemas["V2WalletAutoReloadActionResponse"];
export type WalletAutoReloadRequest = Schemas["V2WalletAutoReloadRequest"];
export type WalletAutoReloadSetupFinalizeRequest =
	Schemas["V2WalletAutoReloadSetupFinalizeRequest"];
export type WalletAutoReloadSetupRequest = Schemas["V2WalletAutoReloadSetupRequest"];
export type WalletAutoReloadSetupResult = Schemas["V2WalletAutoReloadSetupResponse"];
export type WalletState = Schemas["V2WalletResponse"];
export type WalletTopupRequest = Schemas["V2WalletTopupRequest"];
export type WalletTopupResult = Schemas["V2WalletTopupResponse"];
export type WalletTransaction = Schemas["V2WalletTransactionItemResponse"];
