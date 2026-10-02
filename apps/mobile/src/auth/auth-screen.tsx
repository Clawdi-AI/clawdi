import { useSignIn, useSignUp } from "@clerk/expo";
import { Link } from "expo-router";
import { useState } from "react";
import { useI18n } from "../i18n";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { LoadingScreen } from "../ui/feedback";

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
		<AppScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
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
}: {
	email: string;
	onEmailChange: (value: string) => void;
	onPasswordChange: (value: string) => void;
	password: string;
}) {
	const t = useI18n();
	return (
		<AppView className="gap-4">
			<AppTextInput
			autoCapitalize="none"
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
			autoComplete="password"
			className="rounded-2xl bg-surface px-4 py-4 text-base text-foreground"
			onChangeText={onPasswordChange}
			placeholder={t("auth.password")}
			placeholderTextColor="#64748b"
			secureTextEntry
			textContentType="password"
			value={password}
		/>
		</AppView>
	);
}

export function SignInScreen() {
	const t = useI18n();
	const { isLoaded, setActive, signIn } = useSignIn();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const attempt = await signIn.create({ identifier: email.trim(), password });
			if (attempt.status !== "complete" || !attempt.createdSessionId) {
				setError(t("auth.verificationRequired"));
				return;
			}
			await setActive({ session: attempt.createdSessionId });
		} catch {
			setError(t("auth.failed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AuthFrame subtitle={t("auth.signInSubtitle")} title={t("auth.signInTitle")}>
			<AppView className="gap-5">
				<AuthFields
					email={email}
					onEmailChange={setEmail}
					onPasswordChange={setPassword}
					password={password}
				/>
				{error ? <AppText className="text-base text-danger">{error}</AppText> : null}
				<NativeButton label={t("auth.signIn")} onPress={() => void submit()} disabled={busy} />
			</AppView>
			<AppView className="flex-row flex-wrap justify-center gap-1">
				<AppText className="text-base text-muted">{t("auth.noAccount")}</AppText>
				<Link href="/(auth)/sign-up">
					<AppText className="text-base font-semibold text-primary">{t("auth.createAccount")}</AppText>
				</Link>
			</AppView>
		</AuthFrame>
	);
}

export function SignUpScreen() {
	const t = useI18n();
	const { isLoaded, setActive, signUp } = useSignUp();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const attempt = await signUp.create({ emailAddress: email.trim(), password });
			if (attempt.status !== "complete" || !attempt.createdSessionId) {
				setError(t("auth.verificationRequired"));
				return;
			}
			await setActive({ session: attempt.createdSessionId });
		} catch {
			setError(t("auth.failed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<AuthFrame subtitle={t("auth.signUpSubtitle")} title={t("auth.signUpTitle")}>
			<AppView className="gap-5">
				<AuthFields
					email={email}
					onEmailChange={setEmail}
					onPasswordChange={setPassword}
					password={password}
				/>
				{error ? <AppText className="text-base text-danger">{error}</AppText> : null}
				<NativeButton label={t("auth.signUp")} onPress={() => void submit()} disabled={busy} />
			</AppView>
			<AppView className="flex-row flex-wrap justify-center gap-1">
				<AppText className="text-base text-muted">{t("auth.haveAccount")}</AppText>
				<Link href="/(auth)/sign-in">
					<AppText className="text-base font-semibold text-primary">{t("auth.returnToSignIn")}</AppText>
				</Link>
			</AppView>
		</AuthFrame>
	);
}
