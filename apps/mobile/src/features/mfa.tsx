import { pairingQr } from "@clawdi/shared/qr";
import { useUser } from "@clerk/expo";
import type { TOTPResource, UserResource } from "@clerk/expo/types";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useNativeReverification } from "../auth/use-native-reverification";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { QrImage } from "../ui/qr-image";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function MfaScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <MfaForm key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function MfaForm({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const [enabled, setEnabled] = useState(user.totpEnabled);
	const [mfaEnabled, setMfaEnabled] = useState(user.twoFactorEnabled);
	const [phones, setPhones] = useState([...user.phoneNumbers]);
	const [setup, setSetup] = useState<TOTPResource | null>(null);
	const [codes, setCodes] = useState<string[] | null>(null);
	const [code, setCode] = useState("");
	const [success, setSuccess] = useState(false);
	const clear = useCallback(() => {
		setSetup(null);
		setCodes(null);
		setCode("");
	}, []);
	useFocusEffect(useCallback(() => clear, [clear]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => listener.remove();
	}, [clear]);
	const qr = useMemo(
		() => (setup?.uri?.startsWith("otpauth://totp/") ? pairingQr(setup.uri) : null),
		[setup],
	);
	const sync = () => {
		setEnabled(user.totpEnabled);
		setMfaEnabled(user.twoFactorEnabled);
		setPhones([...user.phoneNumbers]);
	};
	const publishCodes = (values: string[]) => {
		if (!values.length || values.some((value) => typeof value !== "string" || !value.trim()))
			throw new Error("Invalid backup codes");
		setCodes([...values]);
	};
	const run = (
		operation:
			| "refresh"
			| "create"
			| "verify"
			| "disable"
			| "backup"
			| "sms-enable"
			| "sms-disable"
			| "sms-default",
		phoneId?: string,
	) =>
		void action.run(async (active) => {
			const visible = capture();
			const current = () =>
				active() &&
				visible() &&
				scope.isCurrent() &&
				!scope.signal.aborted &&
				user.id === scope.accountKey;
			if (!current()) return;
			setSuccess(false);
			if (operation !== "verify") clear();
			try {
				await reverification.execute(async () => {
					if (!current()) throw new Error("Account action retired");
					await user.reload();
					if (!current()) throw new Error("Account action retired");
					sync();
					if (operation === "refresh") return;
					if (
						operation === "sms-enable" ||
						operation === "sms-disable" ||
						operation === "sms-default"
					) {
						const phone = user.phoneNumbers.find((value) => value.id === phoneId);
						if (phone?.verification.status !== "verified")
							throw new Error("Verified phone required");
						let backupCodes: string[] | undefined;
						if (operation === "sms-default") {
							if (!phone.reservedForSecondFactor) throw new Error("SMS factor no longer enabled");
							await phone.makeDefaultSecondFactor();
						} else {
							const reserved = operation === "sms-enable";
							// An explicit retry reconciles first; do not regenerate codes for an already-enabled factor.
							if (phone.reservedForSecondFactor !== reserved) {
								const result = await phone.setReservedForSecondFactor({ reserved });
								if (!current()) return;
								if (result.id !== phoneId || result.reservedForSecondFactor !== reserved)
									throw new Error("SMS factor change not confirmed");
								if (reserved) backupCodes = result.backupCodes;
							}
						}
						if (!current()) return;
						await user.reload();
						if (!current()) return;
						sync();
						const updated = user.phoneNumbers.find((value) => value.id === phoneId);
						if (
							!updated ||
							updated.reservedForSecondFactor !== (operation !== "sms-disable") ||
							(operation === "sms-default" && !updated.defaultSecondFactor)
						)
							throw new Error("SMS factor state not confirmed");
						if (backupCodes?.length) publishCodes(backupCodes);
						setSuccess(true);
						return;
					}
					if (operation === "create") {
						if (user.totpEnabled) throw new Error("Authenticator already enabled");
						const result = await user.createTOTP();
						if (!current()) return;
						if (
							!result.id ||
							result.verified ||
							!result.secret ||
							!/^[A-Z2-7]+=*$/i.test(result.secret)
						)
							throw new Error("Invalid authenticator setup");
						setSetup(result);
						return;
					}
					if (operation === "backup") {
						if (!user.twoFactorEnabled) throw new Error("MFA required");
						const result = await user.createBackupCode();
						if (current()) {
							publishCodes(result.codes);
							setSuccess(true);
						}
						return;
					}
					let backupCodes: string[] | undefined;
					if (operation === "verify") {
						if (user.totpEnabled || !code.trim()) throw new Error("No pending verification");
						const result = await user.verifyTOTP({ code: code.trim() });
						if (!current()) return;
						if (!result.verified || (setup && result.id !== setup.id))
							throw new Error("Authenticator not verified");
						backupCodes = result.backupCodes;
					} else {
						if (user.totpEnabled !== enabled) throw new Error("Authenticator state changed");
						await user.disableTOTP();
						if (!current()) return;
					}
					await user.reload();
					if (!current()) return;
					sync();
					if (user.totpEnabled !== (operation === "verify"))
						throw new Error("Authenticator change not confirmed");
					setSetup(null);
					if (backupCodes?.length) publishCodes(backupCodes);
					setSuccess(true);
				});
			} finally {
				if (active()) setCode("");
			}
		});
	const confirm = (operation: "disable" | "backup") => {
		const visible = capture();
		const ticket = ++confirmation.current;
		const label = t(
			operation === "backup" ? "mfa.backup" : enabled ? "mfa.disable" : "mfa.discard",
		);
		Alert.alert(label, t(operation === "backup" ? "mfa.backupWarning" : "mfa.disableWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: label,
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					run(operation);
				},
			},
		]);
	};
	const confirmSms = (phoneId: string, operation: "sms-enable" | "sms-disable" | "sms-default") => {
		const visible = capture();
		const ticket = ++confirmation.current;
		const label = t(
			operation === "sms-enable"
				? "mfa.smsEnable"
				: operation === "sms-disable"
					? "mfa.smsDisable"
					: "mfa.smsDefault",
		);
		Alert.alert(
			label,
			t(operation === "sms-disable" ? "mfa.smsDisableWarning" : "mfa.smsEnableWarning"),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: label,
					style: operation === "sms-disable" ? "destructive" : "default",
					onPress: () => {
						if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
						confirmation.current++;
						run(operation, phoneId);
					},
				},
			],
		);
	};
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("mfa.title")}
				</AppText>
				<AppText>{t("mfa.description")}</AppText>
				<AppText>{t(enabled ? "mfa.enabled" : "mfa.disabled")}</AppText>
				{reverification.prompt}
				<NativeButton
					label={t("inventory.refresh")}
					disabled={action.busy}
					onPress={() => run("refresh")}
				/>
				{!enabled ? (
					<>
						<NativeButton
							label={t("mfa.setup")}
							disabled={action.busy || Boolean(setup)}
							onPress={() => run("create")}
						/>
						{setup ? (
							<AppView className="gap-3 rounded-xl bg-card p-4">
								<AppText>{t("mfa.setupInstructions")}</AppText>
								{qr ? <QrImage matrix={qr} label={t("mfa.qr")} /> : null}
								<AppText selectable>{setup.secret}</AppText>
							</AppView>
						) : null}
						<AppText>{t("mfa.codeHint")}</AppText>
						<AppTextInput
							accessibilityLabel={t("mfa.code")}
							placeholder={t("mfa.code")}
							value={code}
							onChangeText={setCode}
							editable={!action.busy}
							secureTextEntry
							autoComplete="one-time-code"
							keyboardType="number-pad"
							autoCorrect={false}
							className="rounded-xl bg-card p-3 text-foreground"
						/>
						<NativeButton
							label={t("mfa.verify")}
							disabled={action.busy || !code.trim()}
							onPress={() => run("verify")}
						/>
					</>
				) : null}
				<NativeButton
					label={t(enabled ? "mfa.disable" : "mfa.discard")}
					disabled={action.busy}
					onPress={() => confirm("disable")}
				/>
				<NativeButton
					label={t("mfa.backup")}
					disabled={action.busy || !mfaEnabled}
					onPress={() => confirm("backup")}
				/>
				{codes ? (
					<AppView className="gap-2 rounded-xl bg-card p-4">
						<AppText>{t("mfa.saveCodes")}</AppText>
						<AppText selectable>{codes.join("\n")}</AppText>
						<NativeButton label={t("mfa.hide")} onPress={clear} />
					</AppView>
				) : null}
				<AppText accessibilityRole="header">{t("mfa.smsTitle")}</AppText>
				<AppText>{t("mfa.smsDescription")}</AppText>
				<NativeButton
					label={t("phones.title")}
					disabled={action.busy}
					onPress={() => router.push("/phone-numbers")}
				/>
				{phones
					.filter((phone) => phone.verification.status === "verified")
					.map((phone) => (
						<AppView key={phone.id} className="gap-2 rounded-xl bg-card p-4">
							<AppText selectable>{phone.phoneNumber}</AppText>
							<AppText>
								{t(phone.reservedForSecondFactor ? "mfa.smsEnabled" : "mfa.smsDisabled")}
							</AppText>
							{phone.reservedForSecondFactor && phone.defaultSecondFactor ? (
								<AppText>{t("mfa.smsPreferred")}</AppText>
							) : null}
							<NativeButton
								label={t(phone.reservedForSecondFactor ? "mfa.smsDisable" : "mfa.smsEnable")}
								disabled={action.busy}
								onPress={() =>
									confirmSms(phone.id, phone.reservedForSecondFactor ? "sms-disable" : "sms-enable")
								}
							/>
							{phone.reservedForSecondFactor && !phone.defaultSecondFactor ? (
								<NativeButton
									label={t("mfa.smsDefault")}
									disabled={action.busy}
									onPress={() => confirmSms(phone.id, "sms-default")}
								/>
							) : null}
						</AppView>
					))}
				{action.error ? <AppText accessibilityRole="alert">{t("mfa.failed")}</AppText> : null}
				{success ? <AppText accessibilityRole="alert">{t("mfa.saved")}</AppText> : null}
			</AppScrollView>
		</ReadScreen>
	);
}
