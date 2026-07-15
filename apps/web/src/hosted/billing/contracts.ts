import type { DeployComponents, DeployPaths } from "@clawdi/shared/api";

type Schemas = DeployComponents["schemas"];

type GeneratedCheckoutRequest = Schemas["V2ComputeCheckoutRequest"];
type GeneratedDeploymentDetailsInfo = Schemas["V2HostedDeploymentDetailsInfo"];
type GeneratedDeployRequest = Schemas["V2HostedDeployRequest"];
type GeneratedHostedDeployment = Schemas["V2HostedDeploymentResponse"];

export const COMPUTE_BASIC_SLUG = "compute_basic" as const;
export const COMPUTE_PERFORMANCE_SLUG = "compute_performance" as const;

/**
 * Temporary frontend extension until the hosted backend OpenAPI is regenerated.
 * The committed schema still exposes the retired low-tier slug and omits
 * compute_basic from both deploy request and deployment detail enums. Keep the
 * mismatch isolated here rather than hand-editing deploy.generated.ts.
 */
export type ComputePlanSlug =
	| Exclude<GeneratedDeployRequest["compute_plan_slug"], "compute_free">
	| typeof COMPUTE_BASIC_SLUG;
export type DeployRequest<TPlanSlug extends ComputePlanSlug = ComputePlanSlug> = Omit<
	GeneratedDeployRequest,
	"compute_plan_slug"
> & {
	compute_plan_slug: TPlanSlug;
};
export type CheckoutRequest = Omit<GeneratedCheckoutRequest, "deploy_config"> & {
	deploy_config?: DeployRequest | null;
};
export type DeploymentDetailsInfo = Omit<GeneratedDeploymentDetailsInfo, "compute_plan_slug"> & {
	compute_plan_slug: ComputePlanSlug;
};
export type HostedDeployment = Omit<GeneratedHostedDeployment, "config_info"> & {
	config_info?: DeploymentDetailsInfo | null;
};

type GeneratedCheckoutPath = DeployPaths["/v2/subscription/checkout"];
type GeneratedCheckoutOperation = GeneratedCheckoutPath["post"];
type GeneratedDeploymentsPath = DeployPaths["/v2/deployments"];
type GeneratedCreateDeploymentOperation = GeneratedDeploymentsPath["post"];
type GeneratedCreateDeploymentResponses = GeneratedCreateDeploymentOperation["responses"];
type GeneratedCreateDeploymentSuccess = GeneratedCreateDeploymentResponses[200];
type GeneratedListDeploymentsOperation = GeneratedDeploymentsPath["get"];
type GeneratedListDeploymentsResponses = GeneratedListDeploymentsOperation["responses"];
type GeneratedListDeploymentsSuccess = GeneratedListDeploymentsResponses[200];

/** Remove after deploy.generated.ts includes compute_basic. */
export type BillingDeployPaths = Omit<
	DeployPaths,
	"/v2/deployments" | "/v2/subscription/checkout"
> & {
	"/v2/deployments": Omit<GeneratedDeploymentsPath, "get" | "post"> & {
		get: Omit<GeneratedListDeploymentsOperation, "responses"> & {
			responses: Omit<GeneratedListDeploymentsResponses, 200> & {
				200: Omit<GeneratedListDeploymentsSuccess, "content"> & {
					content: { "application/json": HostedDeployment[] };
				};
			};
		};
		post: Omit<GeneratedCreateDeploymentOperation, "requestBody" | "responses"> & {
			requestBody: { content: { "application/json": DeployRequest } };
			responses: Omit<GeneratedCreateDeploymentResponses, 200> & {
				200: Omit<GeneratedCreateDeploymentSuccess, "content"> & {
					content: { "application/json": HostedDeployment };
				};
			};
		};
	};
	"/v2/subscription/checkout": Omit<GeneratedCheckoutPath, "post"> & {
		post: Omit<GeneratedCheckoutOperation, "requestBody"> & {
			requestBody: { content: { "application/json": CheckoutRequest } };
		};
	};
};

export type AiProviderAuthKind = NonNullable<
	Schemas["V2HostedDeployRequest"]["ai_provider_auth_kind"]
>;
export type BillingOffer = Schemas["V2BillingOfferResponse"];
export type CheckoutResult = Schemas["V2CheckoutResponse"];
export type ComputeSubscriptionActionResult = Schemas["V2ComputeSubscriptionActionResponse"];
export type ComputeSubscriptionCancelRequest = Schemas["V2ComputeSubscriptionCancelRequest"];
export type ComputeFixPaymentRequest = Schemas["V2ComputeFixPaymentRequest"];
export type ComputeInvoice = Schemas["V2ComputeInvoiceInfo"];
export type ComputeInvoicesPage = Schemas["V2ComputeInvoicesResponse"];
export type ComputeSubscriptionResumeRequest = Schemas["V2ComputeSubscriptionResumeRequest"];
export type DeleteDeploymentResult = Schemas["V2DeploymentDeleteResponse"];
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
export type WalletLedgerEntry = Schemas["V2WalletLedgerItemResponse"];
export type WalletLedgerPage = Schemas["V2WalletLedgerResponse"];
export type WalletLedgerStatus = WalletLedgerEntry["status"];
export type WalletPaymentMode = WalletState["payment_mode"];
export type WalletState = Schemas["V2WalletResponse"];
export type WalletTopupRequest = Schemas["V2WalletTopupRequest"];
export type WalletTopupResult = Schemas["V2WalletTopupResponse"];
