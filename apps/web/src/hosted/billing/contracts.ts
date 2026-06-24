import type { DeployComponents } from "@clawdi/shared/api";

type Schemas = DeployComponents["schemas"];

export type ActivationFeeStatus = Schemas["V2ActivationFeeStatusResponse"];
export type AiProviderAuthKind = NonNullable<
	Schemas["V2HostedDeployRequest"]["ai_provider_auth_kind"]
>;
export type BillingOffer = Schemas["V2BillingOfferResponse"];
export type CheckoutRequest = Schemas["V2ComputeCheckoutRequest"];
export type CheckoutResult = Schemas["V2CheckoutResponse"];
export type DeployRequest = Schemas["V2HostedDeployRequest"];
export type DeploymentDetailsInfo = Schemas["V2HostedDeploymentDetailsInfo"];
export type HostedDeployment = Schemas["V2HostedDeploymentResponse"];
export type HostedUser = Schemas["V1UserResponse"];
export type OpenClawConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type PortalResult = Schemas["V2PortalResponse"];
export type RebindAgentAiProviderRequest = Schemas["V2RebindAgentAiProviderRequest"];
export type RuntimeAgentType = Schemas["V2OnboardAgentRequest"]["agent_type"];
export type Subscription = Schemas["V2SubscriptionResponse"];
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
