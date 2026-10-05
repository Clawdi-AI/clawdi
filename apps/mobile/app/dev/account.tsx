import {
	apiKeysPanelClasses,
	billingPageClass,
	generalPanelClasses,
	settingsDialogClasses,
	transactionsSectionClasses,
} from "@clawdi/shared/ui";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { emptySignupDetails } from "../../src/auth/signup-details";
import { SignupDetailsForm } from "../../src/auth/signup-details-form";
import { useI18n } from "../../src/i18n";
import { AuthFields } from "../../src/ui/auth/auth-fields";
import { AuthFrame } from "../../src/ui/auth/auth-frame";
import { ClerkAction, ClerkText } from "../../src/ui/auth/clerk-form";
import { AuthCredentialSecondaryActions } from "../../src/ui/auth/credential-options";
import { ComputeSubscriptionCard } from "../../src/ui/billing/compute-subscription-card";
import { PlanComparison } from "../../src/ui/billing/plan-comparison";
import { SubscriptionDetails } from "../../src/ui/billing/subscription-details";
import { BalanceCard, TransactionRow, WalletSettingsSections } from "../../src/ui/billing/wallet";
import { ReadScreen } from "../../src/ui/read-screen";
import {
	AccountContactsFormView,
	ConnectedAccountsFormView,
	DeleteAccountFormView,
	DeviceSessionsFormView,
	MfaFormView,
	PasskeysFormView,
	PasswordFormView,
	ProfileFormView,
} from "../../src/ui/settings/account-forms";
import { SettingsPanelHeader, SettingsSection } from "../../src/ui/settings/section";
import { AppScrollView } from "../../src/ui/view";
import { WebText, WebView, webView } from "../../src/ui/web-layout";

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
	const [details, setDetails] = useState(emptySignupDetails());
	const noop = () => {};
	const common = { action: { busy: false, error: null }, reverification: { prompt: null } };
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
			<ReadScreen>
				<AppScrollView
					contentContainerClassName={webView(`${billingPageClass} ${settingsDialogClasses.panel}`)}
				>
					<SettingsPanelHeader title={t("billing.details")} />
					<SubscriptionDetails item={subscriptionFixture} onDeployment={noop} />
				</AppScrollView>
			</ReadScreen>
		);

	if (panel === "billing" || panel === "wallet")
		return (
			<ReadScreen>
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
										name: "Compute Basic",
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
										name: "Compute Performance",
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
			</ReadScreen>
		);
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName={webView(generalPanelClasses.panel)}>
				<ClerkText>{t("account.settings")}</ClerkText>
			</AppScrollView>
		</ReadScreen>
	);
}
