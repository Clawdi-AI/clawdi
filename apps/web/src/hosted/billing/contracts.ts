import type { DeployComponents, DeployPaths } from "@clawdi/shared/api";

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
export type ComputeInvoice = Schemas["V2ComputeInvoiceInfo"];
export type ComputeInvoicesPage = Schemas["V2ComputeInvoicesResponse"];
export type ComputeSubscriptionResumeRequest = Schemas["V2ComputeSubscriptionResumeRequest"];
export type DeleteDeploymentResult = Schemas["V2DeploymentDeleteResponse"];
export type DeployRequest = Schemas["V2HostedDeployRequest"];
export type DeploymentDetailsInfo = Schemas["V2HostedDeploymentDetailsInfo"];
export type HostedDeployment = Schemas["V2HostedDeploymentResponse"];
export type HostedDeployRequestStatus = Schemas["V2HostedDeployRequestStatusResponse"];
export type HostedFundingEvent = Schemas["V2HostedFundingEventInfo"];
export type RuntimeUiRedemption = Schemas["V2DeploymentRuntimeUiRedemptionResponse"];
export type HostedUser = Schemas["V1UserResponse"];
export type HostedConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type PortalResult = Schemas["V2PortalResponse"];
export type RebindAgentAiProviderRequest = Schemas["V2RebindAgentAiProviderRequest"];
export type RuntimeAgentType =
	DeployPaths["/v2/deployments/{deployment_id}/agents/{agent_type}"]["patch"]["parameters"]["path"]["agent_type"];
export type SetAgentEnabledRequest = Schemas["V2SetAgentEnabledRequest"];
export type TerminalSessionResponse = Schemas["V2DeploymentTerminalSessionResponse"];
export type UsageDay = Schemas["V2HostedUsageDay"];
export type UsageModelBreakdown = Schemas["V2HostedUsageModelBreakdown"];
export type UsageSummary = Schemas["V2HostedUsageSummaryResponse"];
export type WalletAutoReloadAction = Schemas["V2WalletAutoReloadActionResponse"];
export type WalletAutoReloadRequest = Schemas["V2WalletAutoReloadRequest"];
export type WalletComputeActivateRequest = Schemas["V2WalletComputeActivateRequest"];
export type WalletComputeActivateResult = Schemas["V2WalletComputeActivateResponse"];
export type WalletComputePlanChangeRequest = Schemas["V2WalletComputePlanChangeRequest"];
export type WalletComputePlanChangeResult = Schemas["V2WalletComputePlanChangeResponse"];
export type WalletComputeQuoteRequest = Schemas["V2WalletComputeQuoteRequest"];
export type WalletComputeQuote = Schemas["V2WalletComputeQuoteResponse"];
export type WalletComputeRetryRequest = Schemas["V2WalletComputeRetryRequest"];
export type WalletComputeRetryResult = Schemas["V2WalletComputeRetryResponse"];
export type WalletComputeConflictError = Schemas["V2WalletComputeConflictErrorResponse"];
export type WalletComputeInsufficientError = Schemas["V2WalletComputeInsufficientErrorResponse"];
export type WalletComputeUpstreamError = Schemas["V2WalletComputeUpstreamErrorResponse"];
export type WalletComputeErrorDetail =
	| WalletComputeConflictError["detail"]
	| WalletComputeInsufficientError["detail"]
	| WalletComputeUpstreamError["detail"];
export type WalletLedgerEntry = Schemas["V2WalletLedgerItemResponse"];
export type WalletLedgerPage = Schemas["V2WalletLedgerResponse"];
export type WalletLedgerStatus = WalletLedgerEntry["status"];
export type WalletPaymentMode = WalletState["payment_mode"];
export type WalletState = Schemas["V2WalletResponse"];
export type WalletTopupRequest = Schemas["V2WalletTopupRequest"];
export type WalletTopupResult = Schemas["V2WalletTopupResponse"];
