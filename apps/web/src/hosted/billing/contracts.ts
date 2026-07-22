import type { DeployComponents, RuntimeUiEndpointInfo } from "@clawdi/shared/api";

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
export type DeployRequest = Schemas["V2HostedDeployRequest"];
export type DeploymentOperation = Schemas["LongRunningOperation"];
export type DeploymentUpdateRequest = Schemas["V2UpdateDeploymentRequest"];
export type ProviderModelReference = Schemas["ProviderModelReference"];
export type DeploymentDetailsInfo = {
	compute_plan_slug: ComputePlanSlug;
	primary_model?: ProviderModelReference | null;
	ai_provider_id?: string | null;
	ai_provider_auth_kind: AiProviderAuthKind;
	ai_provider_bindings?: Partial<Record<"openclaw" | "hermes", DeploymentProviderBinding>>;
	public_ports?: number[];
	runtime: "openclaw" | "hermes";
	clawdi_cloud_environments?: Record<string, string>;
	vcpu?: number | null;
	ram_gb?: number | null;
	disk_gb?: number | null;
	language?: string | null;
	timezone?: string | null;
};
export type DeploymentProviderBinding = {
	auth_kind: AiProviderAuthKind;
	provider_id?: string | null;
	provider_ids?: string[];
	primary_model?: ProviderModelReference | null;
};
export type HostedFundingEvent = {
	type: "compute_subscription_fallback";
	funding_source: "stripe" | "wallet";
	reason: "payment_failure" | "canceled" | "refunded" | "disputed" | "admin_forced";
	occurred_at: string;
	prior_plan_slug: string;
	subscription_id: number;
};
export type HostedDeployment = {
	id: string;
	user_id: string;
	deploy_request_id?: string | null;
	name: string;
	app_id: string;
	status: string;
	failure_reason?: string | null;
	endpoints?: string[];
	native_url?: string | null;
	openclaw_control_ui_url?: string | null;
	hermes_control_ui_url?: string | null;
	config_info?: DeploymentDetailsInfo | null;
	compute_subscription?: Schemas["V2HostedComputeSubscriptionInfo"] | null;
	last_funding_event?: HostedFundingEvent | null;
	created_at: string;
	upgrade_available: boolean;
	resource_version: string;
	runtime_ui_endpoint?: RuntimeUiEndpointInfo | null;
};
export type HostedDeploymentRead = Schemas["V2HostedDeploymentReadResponse"];
export type HostedDeployRequestStatus = Schemas["V2HostedDeployRequestReadResponse"];
export type HostedUser = Schemas["V1UserResponse"];
export type HostedConfigRequest = Schemas["V2HostedConfigRequest"];
export type Plan = Schemas["V2PlanResponse"];
export type PortalRequest = Schemas["V2ComputePortalRequest"];
export type PortalResult = Schemas["V2PortalResponse"];
export type RebindAgentAiProviderRequest = Pick<
	DeploymentUpdateRequest,
	| "ai_provider_auth_kind"
	| "ai_provider_bootstrap"
	| "ai_provider_id"
	| "primary_model"
	| "provider_ids"
>;
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
