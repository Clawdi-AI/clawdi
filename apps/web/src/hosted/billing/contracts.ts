import type { DeployComponents } from "@clawdi/shared/api";

type Schemas = DeployComponents["schemas"];

export const COMPUTE_BASIC_SLUG = "compute_basic" as const;
export const COMPUTE_PERFORMANCE_SLUG = "compute_performance" as const;

export type AiProviderAuthKind = NonNullable<
	Schemas["V2HostedDeployRequest"]["ai_provider_auth_kind"]
>;
export type BillingOffer = Schemas["V2BillingOfferResponse"];
export type CheckoutRequest = Schemas["V2ComputeCheckoutRequest"];
export type CheckoutResult = Schemas["V2CheckoutResponse"];
export type ComputePlanSlug = Schemas["V2HostedDeployRequest"]["compute_plan_slug"];
export type ComputeSubscriptionActionResult = Schemas["V2ComputeSubscriptionActionResponse"];
export type ComputeSubscriptionCancelRequest = Schemas["V2ComputeSubscriptionCancelRequest"];
export type ComputeFixPaymentRequest = Schemas["V2ComputeFixPaymentRequest"];
export type ComputeBillingHistoryItem = Schemas["V2ComputeBillingHistoryItem"];
export type ComputeBillingHistoryPage = Schemas["V2ComputeBillingHistoryResponse"];
export type ComputePlanChangeRequest = Schemas["V2ComputePlanChangeRequest"];
export type ComputePlanChangeResponse = Schemas["V2ComputePlanChangeResponse"];
export type ComputePlanChangeQuoteRequest = Schemas["V2ComputePlanChangeQuoteRequest"];
export type ComputePlanChangeQuoteResponse = Schemas["V2ComputePlanChangeQuoteResponse"];
export type ComputeSubscriptionQuoteRequest = Schemas["V2ComputeSubscriptionQuoteRequest"];
export type ComputeSubscriptionQuoteResponse = Schemas["V2ComputeSubscriptionQuoteResponse-Output"];
export type ComputeSubscriptionResumeRequest = Schemas["V2ComputeSubscriptionResumeRequest"];
export type DeploymentOperation = Schemas["LongRunningOperation"];
export type DeploymentUpdateRequest = Schemas["V2UpdateDeploymentRequest"];
export type DeploymentDesiredLifecycle = "running" | "stopped";
export type DeployRequest = Schemas["V2HostedDeployRequest"];
export type HostedDeployment = Schemas["V2HostedDeploymentReadResponse"];
export type HostedDeploymentSpec = Schemas["HostedDeploymentSpec"];
export type HostedDeploymentResource = Schemas["HostedDeploymentResource"];
export type HostedDeploymentStatus = Schemas["HostedDeploymentStatus"];
export type HostedComputeSubscription = NonNullable<
	NonNullable<HostedDeployment["commercial_display"]>["compute_subscription"]
>;
export type HostedDeployRequestStatus = Schemas["V2HostedDeployRequestReadResponse"];
export type HostedEventStreamSnapshotHandoff = Schemas["EventStreamSnapshotHandoff"];
export type HostedFundingFact = Schemas["V2HostedCommercialFundingFactInfo"];
export type HostedRuntimeConfiguration = Schemas["RuntimeConfiguration"];
export type RuntimeUiRedemption = Schemas["V2DeploymentRuntimeUiRedemptionResponse"];
export type HostedUser = Schemas["V1UserResponse"];
export type HostedConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type PortalResult = Schemas["V2PortalResponse"];
export type TerminalSessionResponse = Schemas["V2DeploymentTerminalSessionResponse"];
export type UsageDay = Schemas["V2HostedUsageDay"];
export type UsageModelBreakdown = Schemas["V2HostedUsageModelBreakdown"];
export type UsageSummary = Schemas["V2HostedUsageSummaryResponse"];
export type WalletAutoReloadAction = Schemas["V2WalletAutoReloadActionResponse"];
export type WalletAutoReloadRequest = Schemas["V2WalletAutoReloadRequest"];
export type WalletLedgerEntry = Schemas["V2WalletLedgerItemResponse"];
export type WalletLedgerPage = Schemas["V2WalletLedgerResponse"];
export type WalletLedgerStatus = WalletLedgerEntry["status"];
export type WalletPaymentMode = WalletState["payment_mode"];
export type WalletState = Schemas["V2WalletResponse"];
export type WalletTopupRequest = Schemas["V2WalletTopupRequest"];
export type WalletTopupResult = Schemas["V2WalletTopupResponse"];
