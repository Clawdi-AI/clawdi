import { pairingCommand } from "@clawdi/shared/api";
import { pairingQr } from "@clawdi/shared/qr";
import {
	apiKeysPanelClasses,
	billingPageClass,
	generalPanelClasses,
	settingsDialogClasses,
	transactionsSectionClasses,
} from "@clawdi/shared/ui";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { AuthFields } from "@/components/auth/auth-fields";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ClerkAction, ClerkText } from "@/components/auth/clerk-form";
import { AuthCredentialSecondaryActions } from "@/components/auth/credential-options";
import {
	AccountContactsFormView,
	ConnectedAccountsFormView,
	DeleteAccountFormView,
	DeviceSessionsFormView,
	MfaFormView,
	PasskeysFormView,
	PasswordFormView,
	ProfileFormView,
} from "@/components/settings/account-forms";
import { ApiKeyFormView } from "@/components/settings/api-keys-panel";
import { SettingsPanelHeader, SettingsSection } from "@/components/settings/settings-panel-header";
import { SheetPage } from "@/components/ui/sheet-page";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { ComputeSubscriptionCard } from "@/hosted/billing/subscription/compute-subscription-card";
import { PlanComparison } from "@/hosted/billing/subscription/plan-comparison";
import { SubscriptionDetails } from "@/hosted/billing/subscription/subscription-details";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { TransactionRow } from "@/hosted/billing/wallet/transactions-section";
import { WalletSettingsSections } from "@/hosted/billing/wallet/wallet-sections";
import { ProviderOAuthView } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import { ChannelPairingView } from "@/hosted/v2/channels/pairing-dialog-ui";
import { WhatsAppSessionView } from "@/hosted/v2/channels/whatsapp-device-onboarding";
import { useI18n } from "@/lib/i18n";
import { emptySignupDetails } from "@/platform/auth/signup-details";
import { SignupDetailsForm } from "@/platform/auth/signup-details-form";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

const subscriptionFixture = {
	subscription_id: "csub_fixture",
	subscription_kind: "paid",
	plan_slug: "compute_performance",
	funding_source: "wallet",
	status: "active",
	price_cents: 1900,
	currency: "usd",
	billing_term_months: 1,
	current_period_end: "2026-11-05T12:00:00Z",
	cancel_at_period_end: false,
	agent_name: "Research Assistant",
	is_orphan: false,
	payment_state: "ok",
	latest_failed_invoice_hosted_url: null,
	next_payment_attempt_at: null,
	recovery_action: null,
	pending_plan_slug: null,
} as const;

/** Read-only stories render production presentation components without mounting Clerk hooks. */
export default function AccountStoriesRoute() {
	if (!__DEV__) return <Redirect href="/" />;
	return <AccountStories />;
}
function AccountStories() {
	const { panel = "profile" } = useLocalSearchParams<{ panel?: string }>();
	const t = useI18n();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [details, setDetails] = useState(emptySignupDetails());
	const noop = () => {};
	const common = { action: { busy: false, error: null }, reverification: { prompt: null } };
	if (panel.startsWith("pair-")) {
		const provider = panel.replace("pair-", "");
		const link =
			provider === "telegram"
				? "https://t.me/acme_ops_bot?start=FIXTURE"
				: provider === "whatsapp"
					? `https://wa.me/14155550123?text=${encodeURIComponent(pairingCommand("FIXTURE"))}`
					: null;
		return (
			<SheetPage
				title={`Pair ${provider === "telegram" ? "Telegram" : provider === "discord" ? "Discord" : "WhatsApp"}`}
				fallback="/channels"
			>
				<ChannelPairingView
					provider={provider}
					identity="@acme_ops_bot"
					pairing={{
						id: "fixture-pair",
						agent_link_id: "fixture-link",
						agent_id: "fixture-agent",
						code: "FIXTURE",
						expires_at: new Date(Date.now() + 300_000).toISOString(),
						pairing_command: pairingCommand("FIXTURE"),
						bot_username: "acme_ops_bot",
						discord_install_url:
							"https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=0",
						discord_user_install_url:
							"https://discord.com/oauth2/authorize?client_id=123456789012345678&integration_type=1&scope=applications.commands",
					}}
					link={link}
					busy={false}
					open={noop}
				/>
			</SheetPage>
		);
	}
	if (panel.startsWith("whatsapp-")) {
		const state =
			panel === "whatsapp-connected"
				? "connected"
				: panel === "whatsapp-expired"
					? "expired"
					: "ready";
		return (
			<SheetPage title="Connect WhatsApp" fallback="/channels">
				<WhatsAppSessionView
					session={{
						id: "fixture-session",
						name: "Acme WhatsApp",
						state,
						method: panel === "whatsapp-code" ? "code" : "qr",
						qr: "fixture-only-whatsapp-qr",
						qr_expires_at: "2099-01-01T00:00:00Z",
						pairing_code: panel === "whatsapp-code" ? "1234-5678" : null,
						manual_pairing_code_supported: true,
						started_at: "2026-10-06T12:00:00Z",
						expires_at: "2099-01-01T00:00:00Z",
					}}
					expired={state === "expired"}
					qr={panel === "whatsapp-qr" ? pairingQr("fixture-only-whatsapp-qr") : null}
					focused
					active
					phone=""
					setPhone={noop}
					ready
					busy={false}
					requestCode={noop}
					check={noop}
					review={noop}
					retry={noop}
					cancel={noop}
				/>
			</SheetPage>
		);
	}
	if (panel === "provider-oauth-code" || panel === "provider-oauth-result")
		return (
			<SheetPage title="Set up ChatGPT" fallback="/ai-providers">
				<ProviderOAuthView
					authorization={
						panel === "provider-oauth-code"
							? {
									flow: "device_code",
									oauth_provider: "codex",
									provider_id: "fixture-chatgpt",
									profile: "fixture-profile",
									state: "fixture-state",
									user_code: "FIXT-URE1",
									verification_url: "https://auth.openai.com/codex/device",
									expires_at: "2026-10-07T00:00:00Z",
									poll_interval_seconds: 5,
								}
							: null
					}
					issue={null}
					ready={panel === "provider-oauth-result"}
					online
					busy={false}
					error={null}
					accountReady
					configured
					reconnecting={false}
					begin={noop}
					stop={noop}
					restart={noop}
					open={noop}
				/>
			</SheetPage>
		);
	if (panel === "api-key-result")
		return (
			<ApiKeyFormView
				label=""
				setLabel={noop}
				rawKey="clawdi_fixture_only_story_token"
				sheet={{ close: async () => {} }}
				acknowledged={acknowledged}
				setAcknowledged={setAcknowledged}
				busy={false}
				ready
				error={null}
				create={noop}
				finish={noop}
			/>
		);
	if (panel === "profile")
		return (
			<ProfileFormView
				{...common}
				email="avery@clawdi.dev"
				firstName="Avery"
				lastName="Chen"
				username="avery"
				success={false}
				avatar={{ url: "", custom: false }}
				dirty={false}
				setFirstName={noop}
				setLastName={noop}
				setUsername={noop}
				setSuccess={noop}
				updateAvatar={noop}
				removeAvatar={noop}
				save={noop}
			/>
		);
	if (panel === "password")
		return (
			<PasswordFormView
				{...common}
				enabled
				oldPassword=""
				newPassword=""
				confirmationPassword=""
				otherSessions={false}
				success={false}
				setOldPassword={noop}
				setNewPassword={noop}
				setConfirmationPassword={noop}
				setOtherSessions={noop}
				edit={(setter) => setter}
				update={noop}
				confirmRemove={noop}
			/>
		);
	if (panel === "mfa")
		return (
			<MfaFormView
				{...common}
				enabled={false}
				mfaEnabled={false}
				setup={null}
				qr={null}
				code=""
				codes={null}
				phones={[]}
				success={false}
				setCode={noop}
				clear={noop}
				run={noop}
				confirm={noop}
				confirmSms={noop}
			/>
		);
	if (panel === "passkeys")
		return (
			<PasskeysFormView
				{...common}
				passkeys={[
					{
						id: "fixture-passkey",
						name: "MacBook Pro",
						lastUsedAt: new Date("2026-10-05T12:00:00Z"),
					},
				]}
				edit={null}
				saved={false}
				setEdit={noop}
				setSaved={noop}
				run={noop}
				confirmRemove={noop}
			/>
		);
	if (panel === "email-addresses" || panel === "phone-numbers")
		return (
			<AccountContactsFormView
				{...common}
				kind={panel === "email-addresses" ? "emails" : "phones"}
				contacts={[
					{
						id: "fixture-contact",
						...(panel === "email-addresses"
							? { emailAddress: "avery@clawdi.dev" }
							: { phoneNumber: "+14155550123" }),
						verification: { status: "verified" },
					},
				]}
				primary="fixture-contact"
				draft=""
				verifying={null}
				code=""
				saved={false}
				refresh={noop}
				sendCode={noop}
				confirm={noop}
				verify={noop}
				setCode={noop}
				setDraft={noop}
				add={noop}
			/>
		);
	if (panel === "device-sessions")
		return (
			<DeviceSessionsFormView
				{...common}
				sessions={[
					{
						id: "fixture-current",
						lastActiveAt: new Date("2026-10-05T12:00:00Z"),
						latestActivity: {
							deviceType: "Macintosh",
							browserName: "Chrome",
							browserVersion: "140",
							city: "San Francisco",
							country: "United States",
							ipAddress: "192.0.2.10",
						},
					},
				]}
				scope={{ sessionId: "fixture-current" }}
				revoked={false}
				refresh={noop}
				revoke={noop}
			/>
		);
	if (panel === "connected-accounts")
		return (
			<ConnectedAccountsFormView
				{...common}
				accounts={[
					{
						id: "fixture-github",
						provider: "github",
						verification: { status: "verified" },
						providerTitle: () => "GitHub",
						accountIdentifier: () => "avery-chen",
					},
				]}
				providers={[]}
				saved={false}
				reauthorized={false}
				run={noop}
				authorize={noop}
				confirmRemove={noop}
			/>
		);
	if (panel === "delete-account")
		return (
			<DeleteAccountFormView
				action={common.action}
				email="avery@clawdi.dev"
				compute
				phrase=""
				outcome="idle"
				setPhrase={noop}
				confirm={noop}
				leave={noop}
			/>
		);
	if (panel === "sign-in" || panel === "sign-up" || panel === "sign-up-details")
		return (
			<AuthFrame
				title={t(panel === "sign-in" ? "auth.signInTitle" : "auth.signUpTitle")}
				subtitle={t(panel === "sign-in" ? "auth.signInSubtitle" : "auth.signUpSubtitle")}
			>
				{panel === "sign-up-details" ? (
					<SignupDetailsForm
						fields={["first_name", "last_name", "username"]}
						values={details}
						busy={false}
						onChange={(field, value) => setDetails((previous) => ({ ...previous, [field]: value }))}
					/>
				) : (
					<AuthFields
						email={email}
						password={password}
						onEmailChange={setEmail}
						onPasswordChange={setPassword}
						busy={false}
						newPassword={panel === "sign-up"}
					/>
				)}
				<ClerkAction
					label={t(panel === "sign-in" ? "auth.signIn" : "auth.signUp")}
					variant="default"
					onPress={noop}
					disabled={!email || !password}
				/>
				{panel === "sign-in" || panel === "sign-up" ? (
					<AuthCredentialSecondaryActions
						signingUp={panel === "sign-up"}
						busy={false}
						validEmail={false}
						onVault={noop}
						onEmailCode={noop}
						onForgotPassword={noop}
					/>
				) : null}
				<WebView recipe={apiKeysPanelClasses.form} className="flex-row flex-wrap justify-center">
					<ClerkText>{t(panel === "sign-in" ? "auth.noAccount" : "auth.haveAccount")}</ClerkText>
					<ClerkText className="text-primary font-semibold">
						{t(panel === "sign-in" ? "auth.createAccount" : "auth.returnToSignIn")}
					</ClerkText>
				</WebView>
				<ClerkAction label={t("publicSession.open")} onPress={noop} />
			</AuthFrame>
		);
	if (panel === "subscription-details")
		return (
			<SafeAreaScreen>
				<AppScrollView
					contentContainerClassName={webView(`${billingPageClass} ${settingsDialogClasses.panel}`)}
				>
					<SettingsPanelHeader title={t("billing.details")} />
					<SubscriptionDetails item={subscriptionFixture} onDeployment={noop} />
				</AppScrollView>
			</SafeAreaScreen>
		);

	if (panel === "billing" || panel === "wallet")
		return (
			<SafeAreaScreen>
				<AppScrollView
					contentContainerClassName={webView(`${billingPageClass} ${settingsDialogClasses.panel}`)}
				>
					<SettingsPanelHeader
						title={t(panel === "wallet" ? "billingParity.wallet" : "billingParity.compute")}
						description={t(
							panel === "wallet"
								? "billingParity.walletDescription"
								: "billingParity.computeDescription",
						)}
					/>
					{panel === "wallet" ? (
						<>
							<BalanceCard wallet={{ balance_usd: "42.50" }} />
							<WalletSettingsSections
								wallet={{
									auto_reload_enabled: false,
									auto_reload_threshold_usd: "5.00",
									auto_reload_amount_cents: 2500,
									auto_reload_monthly_cap_cents: 0,
									x402_enabled: false,
								}}
							/>
							<SettingsSection
								title={t("billingParity.transactions")}
								description={t("billingParity.transactionsDescription")}
							>
								<WebView recipe={transactionsSectionClasses.section}>
									<WebView recipe={transactionsSectionClasses.mobileRows}>
										<TransactionRow
											item={{
												id: "fixture-topup",
												kind: "topup",
												occurred_at: "2026-10-05T12:00:00Z",
												amount: "25.00",
												currency: "usd",
												direction: "credit",
												status: "succeeded",
												funding: "card",
											}}
										/>
									</WebView>
									<WebText recipe={transactionsSectionClasses.description}>
										{t("billingParity.transactionsCount").replace("{count}", "1")}
									</WebText>
								</WebView>
							</SettingsSection>
						</>
					) : (
						<>
							<SettingsSection
								title={t("billingParity.subscriptions")}
								description={t("billingParity.subscriptionsDescription")}
							>
								<ComputeSubscriptionCard item={subscriptionFixture} />
							</SettingsSection>
							<PlanComparison
								plans={[
									{
										slug: "compute_basic",
										name: "Basic",
										price_cents: 900,
										signup_grant_usd: "0",
										vcpu: 1,
										ram_gb: 2,
										disk_size: 10,
										offers: [
											{
												billing_term_months: 1,
												price_cents: 900,
												effective_monthly_price_cents: 900,
												discount_percent: 0,
											},
										],
									},
									{
										slug: "compute_performance",
										name: "Performance",
										price_cents: 1900,
										signup_grant_usd: "0",
										vcpu: 2,
										ram_gb: 4,
										disk_size: 20,
										offers: [
											{
												billing_term_months: 1,
												price_cents: 1900,
												effective_monthly_price_cents: 1900,
												discount_percent: 0,
											},
										],
									},
								]}
							/>
						</>
					)}
				</AppScrollView>
			</SafeAreaScreen>
		);
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={webView(generalPanelClasses.panel)}>
				<ClerkText>{t("account.settings")}</ClerkText>
			</AppScrollView>
		</SafeAreaScreen>
	);
}
