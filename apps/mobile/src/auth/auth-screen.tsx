// The custom forms use Clerk's legacy resource API (`create` + `setActive`).
// The root export in @clerk/expo 4.8 exposes the newer signal API instead.
import { useSignIn, useSignUp } from "@clerk/expo/legacy";
import type { SignInResource } from "@clerk/expo/types";
import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { useI18n } from "../i18n";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { type SupportedSecondFactor, selectSecondFactor } from "./sign-in-factor";
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
					<AppText className="text-base leading-6 text-muted">{subtitle}</AppText>
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
				className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
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
				className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
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
	| "first-code"
	| "second-code"
	| "recovery-email"
	| "recovery-code";

function AuthScreen({ mode }: { mode: "sign-in" | "sign-up" }) {
	const t = useI18n();
	const router = useRouter();
	const signInHook = useSignIn();
	const signUpHook = useSignUp();
	const { busy, error, run, clearError } = useAuthAction(mode);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [step, setStep] = useState<AuthStep>("credentials");
	const [factor, setFactor] = useState<SupportedSecondFactor | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
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
				router.replace("/(tabs)");
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

	const submit = () =>
		run(async (isCurrent) => {
			setNotice(null);
			if (!loaded || !setActive) {
				setNotice(t("auth.unavailable"));
				return;
			}
			const completedAttempt = signingUp ? signUp : signIn;
			if (
				verifying &&
				completedAttempt?.status === "complete" &&
				completedAttempt.createdSessionId
			) {
				await finish(completedAttempt.createdSessionId, isCurrent);
				return;
			}
			if (step === "credentials" && signingUp && signUp) {
				const attempt = await signUp.create({ emailAddress: email.trim(), password });
				if (!isCurrent()) return;
				if (attempt.status === "complete" && attempt.createdSessionId) {
					await finish(attempt.createdSessionId, isCurrent);
				} else if (attempt.unverifiedFields.includes("email_address")) {
					await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
					if (!isCurrent()) return;
					setPassword("");
					setStep("sign-up-code");
				} else setNotice(t("auth.unsupportedVerification"));
			} else if (step === "sign-up-code" && signUp) {
				const attempt = await signUp.attemptEmailAddressVerification({ code: code.trim() });
				if (!isCurrent()) return;
				if (attempt.status === "complete" && attempt.createdSessionId)
					await finish(attempt.createdSessionId, isCurrent);
				else setNotice(t("auth.unsupportedVerification"));
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

	const resend = () =>
		run(async (isCurrent) => {
			setNotice(null);
			if (step === "sign-up-code" && signUp) {
				await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
			} else if (step === "recovery-code" && signIn) {
				await signIn.create({ strategy: "reset_password_email_code", identifier: email.trim() });
			} else if (step === "second-code" && factor) {
				await prepareFactor(factor, isCurrent);
			} else if (step === "first-code" && signIn) {
				const next = signIn.supportedFirstFactors?.find(
					(candidate) => candidate.strategy === "email_code",
				);
				if (next?.strategy === "email_code")
					await signIn.prepareFirstFactor({
						strategy: "email_code",
						emailAddressId: next.emailAddressId,
					});
			}
			if (isCurrent()) setNotice(t("auth.codeSent"));
		});

	if (!loaded) return <LoadingScreen label={t("loading.authentication")} />;
	const needsPassword = step === "credentials" || step === "recovery-code";
	const disabled =
		busy ||
		(verifying
			? !code.trim() || (needsPassword && !password)
			: !validEmail || (needsPassword && !password));
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
						className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
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
						className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
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
						className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
						placeholder={t("auth.newPassword")}
						onChangeText={setPassword}
						value={password}
					/>
				) : null}
				{verifying &&
				factor &&
				(factor.strategy === "email_code" || factor.strategy === "phone_code") ? (
					<AppText className="text-base text-muted">
						{t("auth.codeSentTo")} {factor.safeIdentifier}
					</AppText>
				) : null}
				{error || notice ? (
					<AppText
						accessibilityRole={error ? "alert" : "text"}
						className={error ? "text-base text-danger" : "text-base text-muted"}
					>
						{error ? t("auth.failed") : notice}
					</AppText>
				) : null}
				<NativeButton
					label={
						busy
							? t("auth.working")
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
				<AppText className="text-base text-muted">
					{signingUp ? t("auth.haveAccount") : t("auth.noAccount")}
				</AppText>
				<Link href={signingUp ? "/(auth)/sign-in" : "/(auth)/sign-up"} replace>
					<AppText className="text-base font-semibold text-primary">
						{signingUp ? t("auth.returnToSignIn") : t("auth.createAccount")}
					</AppText>
				</Link>
			</AppView>
		</AuthFrame>
	);
}

export function SignInScreen() {
	return <AuthScreen mode="sign-in" />;
}

export function SignUpScreen() {
	return <AuthScreen mode="sign-up" />;
}
