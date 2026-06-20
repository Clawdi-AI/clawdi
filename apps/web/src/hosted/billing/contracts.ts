/**
 * Typed contracts for the hosted billing and deployment surfaces.
 *
 * These mirror the hosted API response/request models for the wallet,
 * subscription, deployment, redemption, and referral routes.
 *
 * Why hand-written instead of generated: `packages/shared/src/api/
 * deploy.generated.ts` is a FILTERED subset (only `/deployments`, and even
 * that copy predates the `ui_access_token` / `*_ui_url` fields). The wallet
 * and subscription paths are not in the allowlist at all. Rather than couple
 * this UI to a regen of a broader OpenAPI surface, the billing surfaces keep
 * their own typed contracts here, isolated under `hosted/`. Field names and
 * bounds track the hosted API contract exactly.
 */

// ── Wallet ──────────────────────────────────────────────────────────────────

export type WalletPaymentMode = "card" | "invoice";

/** Pending Stripe SCA / decline-recovery action attached to the wallet. */
export interface WalletAutoReloadAction {
	attempt_id: string;
	payment_intent_id: string | null;
	client_secret: string | null;
	/** e.g. "card_declined", "authentication_required". */
	error_code: string | null;
}

/** Wallet balance snapshot + auto-reload config. */
export interface WalletState {
	/** Credits balance (1 USD = `points_per_usd` credits). */
	balance_credits: number;
	/** ISO-8601; snapshot time. Null until the first snapshot poll lands. */
	balance_snapshot_at: string | null;
	payment_mode: WalletPaymentMode;
	auto_reload_enabled: boolean;
	auto_reload_threshold_credits: number;
	auto_reload_amount_cents: number;
	/** 0 = unlimited. */
	auto_reload_monthly_cap_cents: number;
	auto_reload_action: WalletAutoReloadAction | null;
	points_per_usd: number;
}

export type WalletLedgerOperation =
	| "topup"
	| "invoice"
	| "x402"
	| "grant_signup"
	| "grant_subscription"
	| "grant_redemption"
	| "grant_referral"
	| "admin_adjust"
	| "proxy"
	| "refund"
	// Backend may add operations; keep the union open for forward-compat.
	| (string & {});

export type WalletLedgerStatus = "pending" | "applied" | "failed";

export interface WalletLedgerEntry {
	id: string;
	operation: WalletLedgerOperation;
	request_id: string;
	/** Positive = credit added, negative = debit. */
	credits_amount: number;
	status: WalletLedgerStatus;
	notes: string | null;
	created_at: string;
	applied_at: string | null;
}

export interface WalletLedgerPage {
	items: WalletLedgerEntry[];
}

export interface WalletTopupRequest {
	amount_cents: number;
	locale?: string | null;
}

/** Card-mode top-up → Stripe PaymentIntent client secret (confirm with Stripe.js). */
export interface WalletTopupPaymentIntentResult {
	status: string;
	flow_type: "payment_intent";
	payment_intent_id: string | null;
	client_secret: string | null;
	credits_added: number;
}

/** Invoice-mode top-up → hosted invoice URL to redirect to. */
export interface WalletTopupInvoiceResult {
	status: string;
	flow_type: string | null;
	url: string | null;
	client_secret: string | null;
	invoice_url: string | null;
	invoice_id: string | null;
	credits_added: number;
}

export type WalletTopupResult = WalletTopupPaymentIntentResult | WalletTopupInvoiceResult;

export interface WalletAutoReloadRequest {
	payment_mode?: WalletPaymentMode | null;
	auto_reload_enabled?: boolean | null;
	auto_reload_threshold_credits?: number | null;
	auto_reload_amount_cents?: number | null;
	auto_reload_monthly_cap_cents?: number | null;
}

// ── Subscription / Compute ──────────────────────────────────────────────────

export interface BillingOffer {
	/** 1 = monthly, 3 = quarterly, 12 = annual. */
	billing_term_months: number;
	price_cents: number;
	effective_monthly_price_cents: number;
	discount_percent: number;
}

export interface Plan {
	slug: string;
	name: string;
	price_cents: number;
	monthly_budget_credits: number;
	points_per_usd: number;
	vcpu: number;
	ram_gb: number;
	disk_size: number;
	instance_type: string | null;
	offers: BillingOffer[];
}

export interface ActivationFeeStatus {
	amount_cents: number;
	satisfied: boolean;
}

export interface Subscription {
	id: string;
	plan_slug: string;
	payment_provider: string | null;
	status: string;
	current_period_start: string | null;
	current_period_end: string | null;
	budget_credits_total: number;
	budget_credits_used: number;
	addon_credits_remaining: number;
	points_per_usd: number;
	use_addon_credits: boolean;
	cancel_at_period_end: boolean;
	billing_term_months: number;
	billing_price_cents_snapshot: number | null;
	pending_billing_term_months: number | null;
	pending_billing_term_effective_at: string | null;
	pending_downgrade_plan_slug: string | null;
	pending_downgrade_effective_at: string | null;
	card_on_file: boolean;
	card_setup_required: boolean;
	card_brand: string | null;
	card_last4: string | null;
	card_exp_month: number | null;
	card_exp_year: number | null;
	created_at: string;
	collection_method: string;
	entitled: boolean;
	activation_fee_amount_cents: number;
	activation_fee_satisfied: boolean;
	pending_collection_method: string | null;
	pending_collection_method_effective_at: string | null;
	entitled_until: string | null;
	invoice_days_until_due: number | null;
	invoice_due_at: string | null;
	contract_source: string | null;
	prepaid_ends_at: string | null;
	allowance_period_start: string | null;
	allowance_period_end: string | null;
	next_allowance_reset_at: string | null;
}

export interface CheckoutRequest {
	plan_slug: string;
	billing_term_months?: number;
	collection_method?: "charge_automatically" | "send_invoice";
	invoice_days_until_due?: number | null;
	deploy_config?: DeployRequest | null;
	ui_mode?: "hosted" | "embedded";
	locale?: string | null;
}

export interface CheckoutResult {
	flow_type: string;
	action_url: string | null;
	checkout_url: string;
	client_secret: string | null;
	invoice_url: string | null;
	invoice_id: string | null;
}

export interface PortalRequest {
	target_plan_slug?: string | null;
	target_billing_term_months?: number | null;
	confirm_upgrade?: boolean;
	locale?: string | null;
}

export interface PortalResult {
	url: string;
	portal_url: string;
	status: string | null;
	redirect_url: string | null;
	payment_intent_client_secret: string | null;
	message: string | null;
	effective_at: string | null;
	amount_due_usd: number | null;
}

// ── Redemption (subscription routes) ─────────────────────────────────────────

export interface RedeemPreviewRequest {
	code: string;
	turnstile_token?: string | null;
}

export interface RedeemPreview {
	valid: boolean;
	reason: string | null;
	offer_code: string | null;
	plan_slug: string | null;
	plan_name: string | null;
	duration_months: number | null;
	allowance_credits: number | null;
	renewal_collection_method: string | null;
	renewal_monthly_price_cents: number | null;
	currency_code: string | null;
	starts_at: string | null;
	ends_at: string | null;
}

export interface RedeemRequest {
	code: string;
	locale?: string | null;
	turnstile_token?: string | null;
	deploy_config?: DeployRequest | null;
}

export interface RedeemResult {
	success: boolean;
	request_id: string;
	subscription: Subscription;
	deployment_queued: boolean;
	deploy_request_id: string | null;
}

// ── Referral ────────────────────────────────────────────────────────────────

export interface MyReferralCode {
	referral_code_id: number;
	code: string;
	url: string;
	status: string;
	code_last4: string;
	total_referrals: number;
	converted_referrals: number;
}

export interface ReferralRewardTier {
	plan_slug: string;
	reward_credits: number;
}

export interface ReferralRewardInfo {
	tiers: ReferralRewardTier[];
}

export interface MyReferralItem {
	referral_attribution_id: number;
	referred_user_id: number | null;
	referred_user_label: string | null;
	status: string;
	source: string;
	capture_surface: string;
	first_captured_at: string;
	converted_at: string | null;
	subscription_id: number | null;
	referred_plan_slug: string | null;
	reward_credits_granted: number | null;
	code_last4: string;
}

export interface MyReferrals {
	items: MyReferralItem[];
	total_referrals: number;
	converted_referrals: number;
}

// ── Identity ────────────────────────────────────────────────────────────────

/** Minimal slice of the cloud-api user profile the billing UI needs. */
export interface HostedUser {
	id: string;
	email: string | null;
	name: string | null;
	/** On-chain deposit address for agent x402 self-funding (if provisioned). */
	evm_wallet_address: string | null;
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface UsageModelBreakdown {
	model: string;
	provider: string | null;
	credits: number;
	tokens: number;
	requests: number;
}

export interface UsageDay {
	date: string;
	credits: number;
}

/** Credit consumption for the current billing period. */
export interface UsageSummary {
	period_start: string;
	period_end: string;
	total_credits: number;
	total_requests: number;
	by_model: UsageModelBreakdown[];
	by_day: UsageDay[];
}

// ── Deployments ─────────────────────────────────────────────────────────────

export type AiProviderAuthKind = "managed" | "api_key" | "codex_oauth";

export interface OpenClawConfigRequest {
	primary_model?: string | null;
	channel?: string | null;
	telegram_bot_token?: string | null;
	telegram_allowed_usernames?: string[] | null;
	discord_bot_token?: string | null;
	discord_guild_id?: string | null;
	assistant_name?: string | null;
	personality?: string | null;
	language?: string | null;
	timezone?: string | null;
	public_ports?: number[] | null;
	enable_openclaw?: boolean;
	enable_hermes?: boolean;
}

export interface DeployRequest {
	profile?: string | null;
	primary_model?: string | null;
	channel?: string | null;
	telegram_bot_token?: string | null;
	telegram_allowed_usernames?: string[] | null;
	discord_bot_token?: string | null;
	discord_guild_id?: string | null;
	model?: string | null;
	assistant_name?: string | null;
	personality?: string | null;
	language?: string | null;
	timezone?: string | null;
	public_ports?: number[] | null;
	enable_openclaw?: boolean | null;
	enable_hermes?: boolean;
	deploy_request_id?: string | null;
	ai_provider_id?: string | null;
	ai_provider_auth_kind?: AiProviderAuthKind | null;
	ai_provider_bootstrap?: Record<string, unknown> | null;
	config?: OpenClawConfigRequest | null;
}

export interface DeploymentDetailsInfo {
	mux_enabled: boolean;
	channel: string | null;
	primary_model: string | null;
	ai_provider_id: string | null;
	ai_provider_auth_kind: AiProviderAuthKind;
	/** Per-runtime provider binding (agent_type → binding). Each runtime on a
	 * compute binds its own provider; this is the source of truth for the
	 * per-runtime AI-provider editor. */
	ai_provider_bindings?: Record<
		string,
		{ provider_id?: string | null; auth_kind?: string | null; primary_model?: string | null }
	> | null;
	public_ports: number[];
	enable_openclaw: boolean;
	enable_hermes: boolean;
	onboarded_agents: string[];
	configured_agents: string[];
	clawdi_cloud_environments: Record<string, string>;
	vcpu: number | null;
	ram_gb: number | null;
	disk_gb: number | null;
}

/**
 * Hosted deployment with UI-exposure fields the shared generated `Deployment`
 * type predates (`ui_access_token` / `*_ui_url`).
 */
export interface HostedDeployment {
	id: string;
	user_id: string;
	name: string;
	app_id: string;
	backend: string | null;
	status: string;
	endpoints: string[];
	ui_access_token: string | null;
	openclaw_ui_url: string | null;
	hermes_ui_url: string | null;
	config_info: DeploymentDetailsInfo | null;
	created_at: string;
	profile: string | null;
}
