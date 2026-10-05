// The custom forms use Clerk's legacy resource API (`create` + `setActive`).
// The root export in @clerk/expo 4.8 exposes the newer signal API instead.

import { publicSessionId } from "@clawdi/shared/api";
import { useSignIn, useSignUp } from "@clerk/expo/legacy";
import type { OAuthProvider, SignInResource, SignUpResource } from "@clerk/expo/types";
import { randomUUID } from "expo-crypto";
import { Link, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { openAuthSessionAsync } from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useMobileRuntimeConfig } from "../config/runtime";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import {
	accountOAuthAuthorizationUrl,
	accountOAuthNonce,
	accountOAuthRedirect,
	oauthReturnUrl,
} from "./account-oauth";
import { type SupportedSecondFactor, selectSecondFactor } from "./sign-in-factor";
import {
	emptySignupDetails,
	type SignupDetailField,
	signupDetailFields,
	signupDetailsRequest,
} from "./signup-details";
import { SignupDetailsForm } from "./signup-details-form";
import { useAuthAction } from "./use-auth-action";

function AuthFrame({
	children,
	subtitle,
	title,
}: {
	children: React.ReactNode;
	subtitle: string;
	title: string;
}) {
	return (
		<AppScrollView
			className="flex-1 bg-background"
			contentContainerStyle={{ flexGrow: 1 }}
			keyboardShouldPersistTaps="handled"
		>
			<AppView className="flex-1 justify-center gap-8 px-6 py-12">
				<AppView className="gap-2">
					<AppText className="text-4xl font-semibold text-foreground">{title}</AppText>
					<AppText className="text-base leading-6 text-muted-foreground">{subtitle}</AppText>
				</AppView>
				{children}
			</AppView>
		</AppScrollView>
	);
}

function AuthFields({
	email,
	onEmailChange,
	onPasswordChange,
	password,
	busy,
	newPassword,
}: {
	email: string;
	onEmailChange: (value: string) => void;
	onPasswordChange: (value: string) => void;
	password: string;
	busy: boolean;
	newPassword: boolean;
}) {
	const t = useI18n();
	return (
		<AppView className="gap-4">
			<AppTextInput
				autoCapitalize="none"
				accessibilityLabel={t("auth.email")}
				editable={!busy}
				autoComplete="email"
				className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
				keyboardType="email-address"
				onChangeText={onEmailChange}
				placeholder={t("auth.email")}
				placeholderTextColor="#64748b"
				textContentType="emailAddress"
				value={email}
			/>
			<AppTextInput
				autoCapitalize="none"
				accessibilityLabel={t("auth.password")}
				editable={!busy}
				autoComplete={newPassword ? "new-password" : "current-password"}
				className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
				onChangeText={onPasswordChange}
				placeholder={t("auth.password")}
				placeholderTextColor="#64748b"
				secureTextEntry
				textContentType={newPassword ? "newPassword" : "password"}
				value={password}
			/>
		</AppView>
	);
}

type AuthStep =
	| "credentials"
	| "sign-up-code"
	| "sign-up-phone-code"
	| "sign-up-details"
	| "first-code"
	| "second-code"
	| "recovery-email"
	| "recovery-code";

function AuthScreen({ mode }: { mode: "sign-in" | "sign-up" }) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const config = useMobileRuntimeConfig();
	const providers = config.ok ? (config.value.clerkOauthProviders ?? []) : [];
	const pageEpoch = useRef(0);
	useFocusEffect(
		useCallback(
			() => () => {
				pageEpoch.current++;
			},
			[],
		),
	);
	const params = useLocalSearchParams<{ publicShareId?: string }>();
	const returnShare =
		typeof params.publicShareId === "string" ? publicSessionId(params.publicShareId) : null;
	const signInHook = useSignIn();
	const signUpHook = useSignUp();
	const { busy, error, run, clearError } = useAuthAction(mode);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [step, setStep] = useState<AuthStep>("credentials");
	const [factor, setFactor] = useState<SupportedSecondFactor | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [details, setDetails] = useState(emptySignupDetails);
	const [missing, setMissing] = useState<SignupDetailField[]>([]);
	const signupAttemptId = useRef<string | null>(null);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				setPassword("");
				setCode("");
				setDetails((value) => ({ ...value, password: "" }));
			}
		});
		return () => listener.remove();
	}, []);
	const signingUp = mode === "sign-up";
	const loaded = signingUp ? signUpHook.isLoaded : signInHook.isLoaded;
	const signIn = signInHook.signIn;
	const signUp = signUpHook.signUp;
	const setActive = signingUp ? signUpHook.setActive : signInHook.setActive;
	const verifying = step.endsWith("code");
	const recovering = step === "recovery-email" || step === "recovery-code";
	const validEmail = /^[^\s@]+@[^\s@]+$/.test(email.trim());

	const finish = async (sessionId: string, isCurrent: () => boolean) => {
		if (!isCurrent() || !setActive) return;
		await setActive({
			session: sessionId,
			navigate: ({ session }) => {
				if (!isCurrent()) return;
				if (session?.currentTask) {
					setNotice(t("auth.sessionTaskRequired"));
					return;
				}
				router.replace(
					returnShare ? { pathname: "/s/[shareId]", params: { shareId: returnShare } } : "/(tabs)",
				);
			},
		});
	};

	const prepareFactor = async (next: SupportedSecondFactor, isCurrent: () => boolean) => {
		if (!signIn || !isCurrent()) return;
		if (next.strategy === "email_code") {
			await signIn.prepareSecondFactor({
				strategy: "email_code",
				emailAddressId: next.emailAddressId,
			});
		} else if (next.strategy === "phone_code") {
			await signIn.prepareSecondFactor({
				strategy: "phone_code",
				phoneNumberId: next.phoneNumberId,
			});
		}
		if (!isCurrent()) return;
		setFactor(next);
		setCode("");
		setPassword("");
		setStep("second-code");
	};

	const advanceSignIn = async (attempt: SignInResource, isCurrent: () => boolean) => {
		if (!isCurrent() || !signIn) return;
		if (attempt.status === "complete" && attempt.createdSessionId) {
			await finish(attempt.createdSessionId, isCurrent);
		} else if (
			attempt.status === "needs_second_factor" ||
			attempt.status === "needs_client_trust"
		) {
			const next = selectSecondFactor(attempt);
			if (next) await prepareFactor(next, isCurrent);
			else setNotice(t("auth.unsupportedVerification"));
		} else if (attempt.status === "needs_first_factor") {
			const next = attempt.supportedFirstFactors?.find(
				(candidate) => candidate.strategy === "email_code",
			);
			if (next?.strategy !== "email_code") {
				setNotice(t("auth.unsupportedVerification"));
				return;
			}
			await signIn.prepareFirstFactor({
				strategy: "email_code",
				emailAddressId: next.emailAddressId,
			});
			if (!isCurrent()) return;
			setPassword("");
			setCode("");
			setStep("first-code");
		} else {
			setNotice(t("auth.unsupportedVerification"));
		}
	};

	const advanceSignUp = async (attempt: SignUpResource, current: () => boolean) => {
		if (!current() || !signUp) return;
		if (!attempt.id || signUp.id !== attempt.id) throw new Error("Signup attempt changed");
		signupAttemptId.current = attempt.id;
		const attemptId = attempt.id;
		const ownsAttempt = () =>
			current() && signUp.id === attemptId && signupAttemptId.current === attemptId;
		if (attempt.status === "complete" && attempt.createdSessionId) {
			await finish(attempt.createdSessionId, ownsAttempt);
			return;
		}
		if (attempt.status !== "missing_requirements") {
			setNotice(t("auth.unsupportedVerification"));
			return;
		}
		setPassword("");
		setCode("");
		setFactor(null);
		if (attempt.missingFields.length) {
			const fields = signupDetailFields(attempt.missingFields);
			if (!fields) {
				setNotice(t("signupDetails.unsupported"));
				return;
			}
			setMissing(fields);
			setDetails({
				...emptySignupDetails(),
				first_name: attempt.firstName ?? "",
				last_name: attempt.lastName ?? "",
				username: attempt.username ?? "",
				email_address: attempt.emailAddress ?? "",
				phone_number: attempt.phoneNumber ?? "",
			});
			setStep("sign-up-details");
		} else if (attempt.unverifiedFields.includes("email_address")) {
			setStep("sign-up-code");
			await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
		} else if (attempt.unverifiedFields.includes("phone_number")) {
			setStep("sign-up-phone-code");
			await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
		} else setNotice(t("auth.unsupportedVerification"));
	};

	const submit = () =>
		run(async (isCurrent) => {
			setNotice(null);
			if (!loaded || !setActive) {
				setNotice(t("auth.unavailable"));
				return;
			}
			const signupContinuation = step.startsWith("sign-up-");
			const expectedSignupId = signupAttemptId.current;
			if (signupContinuation && (!expectedSignupId || signUp?.id !== expectedSignupId))
				throw new Error("Signup attempt changed");
			const current = () => isCurrent() && (!signupContinuation || signUp?.id === expectedSignupId);
			const completedAttempt = signingUp || signupContinuation ? signUp : signIn;
			if (
				(verifying || step === "sign-up-details") &&
				completedAttempt?.status === "complete" &&
				completedAttempt.createdSessionId
			) {
				await finish(completedAttempt.createdSessionId, current);
				return;
			}
			if (step === "credentials" && signingUp && signUp) {
				const attempt = await signUp.create({ emailAddress: email.trim(), password });
				await advanceSignUp(attempt, isCurrent);
			} else if (step.startsWith("sign-up-") && signUp) {
				if (signUp.id !== signupAttemptId.current) throw new Error("Signup attempt changed");
				const attempt =
					step === "sign-up-details"
						? await signUp.update(signupDetailsRequest(signUp.missingFields, details))
						: step === "sign-up-phone-code"
							? await signUp.attemptPhoneNumberVerification({ code: code.trim() })
							: await signUp.attemptEmailAddressVerification({ code: code.trim() });
				if (!current()) return;
				if (attempt.id !== expectedSignupId) throw new Error("Signup attempt changed");
				setDetails((value) => ({ ...value, password: "" }));
				await advanceSignUp(attempt, current);
			} else if (signIn) {
				if (step === "recovery-email") {
					await signIn.create({ strategy: "reset_password_email_code", identifier: email.trim() });
					if (!isCurrent()) return;
					setPassword("");
					setCode("");
					setStep("recovery-code");
					return;
				}
				const attempt =
					step === "recovery-code"
						? await signIn.attemptFirstFactor({
								strategy: "reset_password_email_code",
								code: code.trim(),
								password,
							})
						: step === "first-code"
							? await signIn.attemptFirstFactor({ strategy: "email_code", code: code.trim() })
							: step === "second-code" && factor
								? await signIn.attemptSecondFactor({ strategy: factor.strategy, code: code.trim() })
								: await signIn.create({ identifier: email.trim(), password });
				await advanceSignIn(attempt, isCurrent);
			} else setNotice(t("auth.unavailable"));
		});

	const startSocial = (provider: OAuthProvider) =>
		run(async (active) => {
			const epoch = pageEpoch.current;
			const signal = scope.signal;
			const current = () =>
				active() &&
				!signal.aborted &&
				scope.isCurrent() &&
				scope.identity === null &&
				pageEpoch.current === epoch;
			const visible = capture();
			if (!current() || !visible() || !signIn || !signUp || !providers.includes(provider)) return;
			setNotice(null);
			setPassword("");
			setCode("");
			setFactor(null);
			const redirectUrl = accountOAuthRedirect(randomUUID(), mode, returnShare);
			const attempt = await signIn.create({ strategy: `oauth_${provider}`, redirectUrl });
			if (!current() || !visible()) return;
			const attemptId = attempt.id;
			if (!attemptId) throw new Error("Missing sign-in attempt");
			const url = accountOAuthAuthorizationUrl(
				attempt.firstFactorVerification.externalVerificationRedirectURL,
			);
			const result = await openAuthSessionAsync(url, oauthReturnUrl(mode));
			if (!current() || result.type !== "success") return;
			if (signIn.id !== attemptId) throw new Error("Sign-in attempt changed");
			const rotatingTokenNonce = accountOAuthNonce(result.url, redirectUrl);
			const completed = await signIn.reload({ rotatingTokenNonce });
			if (!current()) return;
			if (completed.id !== attemptId) throw new Error("Sign-in attempt changed");
			if (completed.firstFactorVerification.status === "transferable") {
				const signup = await signUp.create({ transfer: true });
				await advanceSignUp(signup, current);
			} else await advanceSignIn(completed, current);
		});

	const startEmailCode = () =>
		run(async (isCurrent) => {
			if (!loaded || !signIn || signingUp || !validEmail || !isCurrent()) return;
			setNotice(null);
			setPassword("");
			setCode("");
			setFactor(null);
			// Discover the server's permitted factors without submitting a password.
			const attempt = await signIn.create({ identifier: email.trim() });
			await advanceSignIn(attempt, isCurrent);
		});

	const resend = () =>
		run(async (isCurrent) => {
			setNotice(null);
			if (step.startsWith("sign-up-") && signUp?.id !== signupAttemptId.current)
				throw new Error("Signup attempt changed");
			if (step === "sign-up-code" && signUp) {
				await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
			} else if (step === "sign-up-phone-code" && signUp) {
				await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
			} else if (step === "recovery-code" && signIn) {
				await signIn.create({ strategy: "reset_password_email_code", identifier: email.trim() });
			} else if (step === "second-code" && factor) {
				await prepareFactor(factor, isCurrent);
			} else if (step === "first-code" && signIn) {
				const next = signIn.supportedFirstFactors?.find(
					(candidate) => candidate.strategy === "email_code",
				);
				if (next?.strategy !== "email_code") throw new Error("Email factor unavailable");
				await signIn.prepareFirstFactor({
					strategy: "email_code",
					emailAddressId: next.emailAddressId,
				});
			}
			if (isCurrent()) setNotice(t("auth.codeSent"));
		});

	if (!loaded) return <LoadingScreen label={t("loading.authentication")} />;
	const needsPassword = step === "credentials" || step === "recovery-code";
	const canFinalizeSignup =
		step.startsWith("sign-up-") &&
		signUp?.status === "complete" &&
		Boolean(signUp.createdSessionId);
	const disabled =
		busy ||
		(!canFinalizeSignup &&
			(step === "sign-up-details"
				? missing.some((field) => !details[field])
				: verifying
					? !code.trim() || (needsPassword && !password)
					: !validEmail || (needsPassword && !password)));
	const codeLabel =
		factor?.strategy === "totp"
			? t("auth.authenticatorCode")
			: factor?.strategy === "backup_code"
				? t("auth.backupCode")
				: t("auth.verificationCode");
	const backupFactor = signIn?.supportedSecondFactors?.find(
		(candidate) => candidate.strategy === "backup_code",
	);
	return (
		<AuthFrame
			title={
				recovering
					? t("auth.recoveryTitle")
					: signingUp
						? t("auth.signUpTitle")
						: t("auth.signInTitle")
			}
			subtitle={
				recovering
					? t("auth.recoverySubtitle")
					: verifying
						? t("auth.codeSubtitle")
						: signingUp
							? t("auth.signUpSubtitle")
							: t("auth.signInSubtitle")
			}
		>
			<AppView className="gap-5">
				{step === "sign-up-details" ? (
					<>
						<AppText>{t("signupDetails.description")}</AppText>
						<SignupDetailsForm
							fields={missing}
							values={details}
							busy={busy}
							onChange={(field, value) =>
								setDetails((previous) => ({ ...previous, [field]: value }))
							}
						/>
					</>
				) : null}
				{step === "sign-up-phone-code" ? <AppText>{t("signupDetails.phoneCode")}</AppText> : null}
				{step === "credentials" ? (
					<AuthFields
						email={email}
						onEmailChange={setEmail}
						onPasswordChange={setPassword}
						password={password}
						busy={busy}
						newPassword={signingUp}
					/>
				) : null}
				{step === "recovery-email" ? (
					<AppTextInput
						accessibilityLabel={t("auth.email")}
						editable={!busy}
						autoCapitalize="none"
						autoComplete="email"
						keyboardType="email-address"
						textContentType="emailAddress"
						className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
						placeholder={t("auth.email")}
						onChangeText={setEmail}
						value={email}
					/>
				) : null}
				{verifying ? (
					<AppTextInput
						accessibilityLabel={codeLabel}
						editable={!busy}
						autoCapitalize="none"
						autoComplete={factor?.strategy === "backup_code" ? "off" : "one-time-code"}
						keyboardType={factor?.strategy === "backup_code" ? "default" : "number-pad"}
						textContentType="oneTimeCode"
						className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
						placeholder={codeLabel}
						onChangeText={setCode}
						value={code}
					/>
				) : null}
				{step === "recovery-code" ? (
					<AppTextInput
						accessibilityLabel={t("auth.newPassword")}
						editable={!busy}
						autoCapitalize="none"
						autoComplete="new-password"
						textContentType="newPassword"
						secureTextEntry
						className="rounded-2xl bg-card px-4 py-4 text-base text-foreground"
						placeholder={t("auth.newPassword")}
						onChangeText={setPassword}
						value={password}
					/>
				) : null}
				{verifying &&
				factor &&
				(factor.strategy === "email_code" || factor.strategy === "phone_code") ? (
					<AppText className="text-base text-muted-foreground">
						{t("auth.codeSentTo")} {factor.safeIdentifier}
					</AppText>
				) : null}
				{error || notice ? (
					<AppText
						accessibilityRole={error ? "alert" : "text"}
						className={error ? "text-base text-destructive" : "text-base text-muted-foreground"}
					>
						{error ? t("auth.failed") : notice}
					</AppText>
				) : null}
				<NativeButton
					label={
						busy
							? t("auth.working")
							: step === "sign-up-details"
								? t("signupDetails.continue")
								: step === "recovery-email"
									? t("auth.sendRecoveryCode")
									: step === "recovery-code"
										? t("auth.resetPassword")
										: verifying
											? t("auth.verify")
											: signingUp
												? t("auth.signUp")
												: t("auth.signIn")
					}
					onPress={() => void submit()}
					disabled={disabled}
				/>
				{step === "credentials" ? (
					<NativeButton
						label={t("vault.supplyTitle")}
						disabled={busy}
						onPress={() => router.replace("/vault-supply")}
					/>
				) : null}
				{step === "credentials"
					? providers.map((provider) => (
							<NativeButton
								key={provider}
								label={`${t("auth.continueWith")} · ${provider}`}
								disabled={busy || !signInHook.isLoaded || !signUpHook.isLoaded}
								onPress={() => void startSocial(provider)}
							/>
						))
					: null}
				{verifying && factor?.strategy !== "totp" && factor?.strategy !== "backup_code" ? (
					<NativeButton
						label={t("auth.resendCode")}
						onPress={() => void resend()}
						disabled={busy}
					/>
				) : null}
				{step === "second-code" &&
				factor?.strategy !== "backup_code" &&
				backupFactor?.strategy === "backup_code" ? (
					<NativeButton
						label={t("auth.useBackupCode")}
						onPress={() =>
							void run(async (isCurrent) => {
								setNotice(null);
								await prepareFactor(backupFactor, isCurrent);
							})
						}
						disabled={busy}
					/>
				) : null}
				{!signingUp && step === "credentials" ? (
					<NativeButton
						label={t("auth.signInWithEmailCode")}
						disabled={busy || !validEmail}
						onPress={() => void startEmailCode()}
					/>
				) : null}
				{!signingUp && step === "credentials" ? (
					<NativeButton
						label={t("auth.forgotPassword")}
						disabled={busy}
						onPress={() => {
							clearError();
							setNotice(null);
							setPassword("");
							setStep("recovery-email");
						}}
					/>
				) : null}
				{step !== "credentials" ? (
					<NativeButton
						label={t("auth.startOver")}
						disabled={busy}
						onPress={() => {
							clearError();
							setStep("credentials");
							setDetails(emptySignupDetails());
							setMissing([]);
							signupAttemptId.current = null;
							setFactor(null);
							setCode("");
							setPassword("");
							setNotice(null);
						}}
					/>
				) : null}
			</AppView>
			<AppView
				className="flex-row flex-wrap justify-center gap-1"
				pointerEvents={busy ? "none" : "auto"}
			>
				<AppText className="text-base text-muted-foreground">
					{signingUp ? t("auth.haveAccount") : t("auth.noAccount")}
				</AppText>
				<Link
					href={{
						pathname: signingUp ? "/(auth)/sign-in" : "/(auth)/sign-up",
						params: returnShare ? { publicShareId: returnShare } : {},
					}}
					replace
				>
					<AppText className="text-base font-semibold text-primary">
						{signingUp ? t("auth.returnToSignIn") : t("auth.createAccount")}
					</AppText>
				</Link>
			</AppView>
			<NativeButton
				label={t("publicSession.open")}
				disabled={busy}
				onPress={() => router.push("/open-share")}
			/>
		</AuthFrame>
	);
}

export function SignInScreen() {
	return <AuthScreen mode="sign-in" />;
}

export function SignUpScreen() {
	return <AuthScreen mode="sign-up" />;
}
