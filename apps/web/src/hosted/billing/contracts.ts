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
export type ComputeFixPaymentRequest = Schemas["V2ComputeFixPaymentRequest"];
export type ComputeBillingHistoryItem = Schemas["V2ComputeBillingHistoryItem"];
export type ComputePlanChangeRequest = Schemas["V2ComputePlanChangeRequest"];
export type ComputePlanChangeResult =
	| { kind: "complete"; effectiveAt: string }
	| { kind: "scheduled"; effectiveAt: string }
	| { kind: "pending"; waitingFor: "payment" | "update" };
export type ComputePlanChangeQuoteRequest = Schemas["V2ComputePlanChangeQuoteRequest"];
export type ComputePlanChangeQuoteResponse = Schemas["V2ComputePlanChangeQuoteResponse"];
export type ComputeSubscriptionQuoteRequest = Schemas["V2ComputeSubscriptionQuoteRequest"];
export type ComputeSubscriptionQuoteResponse = Schemas["V2ComputeSubscriptionQuoteResponse-Output"];
export type ComputeSubscriptionResumeRequest = Schemas["V2ComputeSubscriptionResumeRequest"];
export type DeploymentCreateRequest = Schemas["V2HostedDeployRequest"];
export type DeploymentDeleteRequest = Schemas["V2DeleteDeploymentRequest"];
export type DeploymentUpdateRequest = Schemas["V2UpdateDeploymentRequest"];
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
export type HostedSkillCatalogItem = Schemas["V1SkillCatalogItem"];
export type HostedSkillCatalogResponse = Schemas["V1SkillCatalogResponse"];
export type HostedSkillInstallResponse = Schemas["V1SkillInstallResponse"];
export type HostedSkillsStatusResponse = Schemas["V1SkillsStatusResponse"];
export type HostedSkillStatusItem = Schemas["V1SkillStatusItem"];
export type HostedSkillUninstallResponse = Schemas["V1SkillUninstallResponse"];
export type ManagedModelCatalogItem = Schemas["V2ManagedModelCatalogItem"];
export type HostedUser = Schemas["V1UserResponse"];
export type HostedConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type WalletAutoReloadAction = Schemas["V2WalletAutoReloadActionResponse"];
export type WalletAutoReloadRequest = Schemas["V2WalletAutoReloadRequest"];
export type WalletLedgerEntry = Schemas["V2WalletLedgerItemResponse"];
export type WalletLedgerStatus = WalletLedgerEntry["status"];
export type WalletState = Schemas["V2WalletResponse"];
export type WalletTopupRequest = Schemas["V2WalletTopupRequest"];
export type WalletTopupResult = Schemas["V2WalletTopupResponse"];
