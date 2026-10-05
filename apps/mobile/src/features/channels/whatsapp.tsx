import {
	pairCodeExpired,
	redactWhatsAppSession,
	type WhatsAppSession,
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
} from "@clawdi/shared/api";
import { pairingQr } from "@clawdi/shared/qr";
import { agentsIndexClasses, whatsappDeviceOnboardingClasses as styles } from "@clawdi/shared/ui";
import { whatsappOnboardingCopy as copy } from "@clawdi/shared/view";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ActionButton as NativeButton, NativeSwitch } from "../../ui/agents/controls";
import { Alert } from "../../ui/alert";
import { Input as AppTextInput, Label } from "../../ui/input";
import { PageHeader } from "../../ui/page-header";
import { AppScrollView, AppText, AppView } from "../../ui/primitives";
import { QrImage } from "../../ui/qr-image";
import { ReadScreen } from "../../ui/read-screen";
import { WebText, WebView, webView } from "../../ui/web-layout";
import { BackButton } from "../cloud-inventory";
import { routeParam } from "../read-helpers";
import { useChannelQuery } from "./queries";

export function WhatsAppScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ accountId?: string | string[] }>();
	const accountId = routeParam(params.accountId);
	return (
		<WhatsAppFlow
			key={`${scope.accountKey}:${scope.generation}:${accountId}`}
			accountId={accountId}
			invalidRoute={params.accountId !== undefined && !accountId}
		/>
	);
}

function WhatsAppFlow({ accountId, invalidRoute }: { accountId?: string; invalidRoute: boolean }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { whatsapp } = useMobileApi();
	const cache = useQueryClient();
	const router = useRouter();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [session, setSession] = useState<WhatsAppSession | null>(null);
	const [name, setName] = useState("");
	const [phone, setPhone] = useState("");
	const [approved, setApproved] = useState(false);
	const [started, setStarted] = useState(false);
	const attempt = useRef<{ id: string; name: string } | null>(null);
	const generation = useRef(0);
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(AppState.currentState === "active");
	const [online, setOnline] = useState(onlineManager.isOnline());
	const [pulse, setPulse] = useState(0);
	const [pollError, setPollError] = useState(false);
	const [now, setNow] = useState(Date.now());
	const redact = useCallback(() => {
		generation.current++;
		setPulse((value) => value + 1);
		setSession((value) => (value ? redactWhatsAppSession(value) : null));
		setPhone("");
	}, []);
	useFocusEffect(
		useCallback(() => {
			setFocused(true);
			return () => {
				redact();
				setFocused(false);
			};
		}, [redact]),
	);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") redact();
			setActive(state === "active");
		});
		const unsubscribe = onlineManager.subscribe((value) => {
			if (!value) redact();
			setOnline(value);
		});
		return () => {
			listener.remove();
			unsubscribe();
		};
	}, [redact]);
	const readiness = useQuery({
		queryKey: accountQueryKey(scope, "whatsapp-readiness"),
		queryFn: ({ signal }) => read((lease) => whatsapp.readiness(lease), signal),
		enabled: scope.isReady && !accountId && !invalidRoute,
		retry: false,
	});
	const owned = useChannelQuery(["owned"], (api, signal) => api.list(signal), Boolean(accountId));
	const repairable =
		!owned.isError &&
		owned.data?.some((bot) => bot.id === accountId && bot.provider === "whatsapp");
	const ready =
		scope.isReady &&
		focused &&
		active &&
		online &&
		!invalidRoute &&
		(session ||
			(accountId
				? repairable
				: attempt.current || (!readiness.isError && readiness.data?.available)));
	const refreshInventory = useCallback(async () => {
		await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "channels") });
	}, [cache, scope]);
	const run = (operation: (signal: AbortSignal) => Promise<WhatsAppSession>) =>
		action.run(async (current) => {
			const visible = capture();
			if (!ready || !visible()) return;
			generation.current++;
			setPollError(false);
			setPhone("");
			setSession((value) => (value ? redactWhatsAppSession(value) : null));
			const result = await read(operation);
			if (!current()) return;
			// Preserve only recovery metadata if the user switched to WhatsApp meanwhile.
			setSession(visible() ? result : redactWhatsAppSession(result));
			if (result.state === "connected") await refreshInventory();
		});
	useEffect(() => {
		if (
			!session ||
			!focused ||
			!active ||
			!online ||
			action.busy ||
			pollError ||
			!whatsappOnboardingShouldPoll(session.state)
		)
			return;
		const controller = new AbortController();
		const version = generation.current;
		const visible = capture();
		const current = () =>
			!controller.signal.aborted &&
			generation.current === version &&
			visible() &&
			scope.isCurrent();
		let timer: ReturnType<typeof setTimeout>;
		let failures = 0;
		const poll = async () => {
			if (!current() || pairCodeExpired(session.expires_at, Date.now())) return;
			try {
				const result = await read((signal) => whatsapp.get(session.id, signal), controller.signal);
				if (!current()) return;
				setSession(result);
				failures = 0;
				if (result.state === "connected") {
					await refreshInventory();
					return;
				}
				if (!whatsappOnboardingShouldPoll(result.state)) return;
			} catch {
				if (!current()) return;
				if (++failures >= 3) {
					setPollError(true);
					return;
				}
			}
			if (current()) timer = setTimeout(() => void poll(), 2000);
		};
		timer = setTimeout(() => void poll(), 1200);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [
		session?.id,
		session?.state,
		session?.expires_at,
		focused,
		active,
		online,
		action.busy,
		pollError,
		pulse,
		read,
		whatsapp,
		capture,
		scope,
		refreshInventory,
	]);
	useEffect(() => {
		if (!session || !focused || !active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [session?.id, focused, active]);
	const expired = Boolean(session && pairCodeExpired(session.expires_at, now));
	const qrValue =
		focused &&
		active &&
		session?.state === "ready" &&
		!expired &&
		session.method === "qr" &&
		session.qr_expires_at &&
		!pairCodeExpired(session.qr_expires_at, now)
			? session.qr
			: null;
	const qr = useMemo(() => (qrValue ? pairingQr(qrValue) : null), [qrValue]);
	return (
		<ReadScreen>
			<AppScrollView
				contentContainerClassName={webView(agentsIndexClasses.page)}
				keyboardShouldPersistTaps="handled"
			>
				<BackButton />
				<PageHeader title={t(accountId ? "whatsapp.repair" : "whatsapp.title")} />
				<Alert>
					<WebText recipe={styles.textXsTextMutedForeground}>
						{t(accountId ? "whatsapp.repairWarning" : "whatsapp.warning")}
					</WebText>
				</Alert>
				<WebText recipe={styles.textXsTextMutedForeground}>{t("whatsapp.leaving")}</WebText>
				{!online ? <AppText accessibilityRole="alert">{t("whatsapp.offline")}</AppText> : null}
				{!session ? (
					<>
						{!ready ? <AppText>{t("whatsapp.unavailable")}</AppText> : null}
						{!accountId ? (
							<WebView recipe={styles.spaceY}>
								<Label>{copy.accountName}</Label>
								<AppTextInput
									accessibilityLabel={copy.accountName}
									placeholder={copy.accountPlaceholder}
									value={name}
									onChangeText={setName}
									editable={!started && !action.busy}
									maxLength={120}
								/>
								<WebText recipe={styles.textXsTextMutedForeground}>{copy.nameHint}</WebText>
							</WebView>
						) : null}
						<NativeSwitch
							value={approved}
							onValueChange={setApproved}
							disabled={action.busy}
							label={t("whatsapp.approve")}
						/>
						<NativeButton
							label={
								started
									? t("whatsapp.retryStart")
									: accountId
										? t("whatsapp.repair")
										: copy.generateQr
							}
							disabled={!ready || !approved || action.busy || (!accountId && !name.trim())}
							onPress={() =>
								void run((signal) => {
									setStarted(true);
									if (accountId) return whatsapp.repair(accountId, signal);
									const saved = attempt.current ?? { id: randomUUID(), name: name.trim() };
									attempt.current = saved;
									return whatsapp.start(saved.id, saved.name, signal);
								})
							}
						/>
						{started ? <AppText>{t("whatsapp.uncertain")}</AppText> : null}
						<NativeButton
							label={t("channels.refresh")}
							disabled={action.busy}
							onPress={() =>
								void action.run(async () => {
									if (accountId) await owned.refetch();
									else await readiness.refetch();
								})
							}
						/>
					</>
				) : (
					<>
						<WebView recipe={styles.flexMinHFlexColItemsCenter}>
							<WebText recipe={styles.maxWFullFontMediumOverflowWrapAnywhere}>
								{session.state === "ready" ? t("whatsapp.ready") : copy[session.state]}
							</WebText>
						</WebView>
						{expired && whatsappOnboardingShouldPoll(session.state) ? (
							<AppText>{t("whatsapp.expired")}</AppText>
						) : null}
						{qr ? (
							<AppView className="items-center">
								<QrImage matrix={qr} label={t("whatsapp.qrLabel")} />
							</AppView>
						) : null}
						{session.state === "ready" && !expired ? (
							<>
								<WebText recipe={styles.textSmFontMedium}>{copy.scanInstruction}</WebText>
								<WebText recipe={styles.textXsTextMutedForeground}>{copy.phoneWarning}</WebText>
								{!qr && session.method === "qr" ? (
									<AppText>{t("whatsapp.qrWaiting")}</AppText>
								) : null}
								{focused && active && session.method === "code" && session.pairing_code ? (
									<>
										<WebText recipe={styles.textSmFontMedium}>
											{t("whatsapp.codeInstructions")}
										</WebText>
										<AppText selectable className="text-2xl font-semibold text-foreground">
											{session.pairing_code}
										</AppText>
									</>
								) : null}
								{session.manual_pairing_code_supported && session.method !== "code" ? (
									<WebView recipe={styles.roundedLgBorderBgMutedP}>
										<WebText recipe={styles.textSmFontMedium}>{copy.fallback}</WebText>
										<AppTextInput
											accessibilityLabel={t("whatsapp.phone")}
											placeholder={t("whatsapp.phone")}
											value={phone}
											onChangeText={setPhone}
											keyboardType="phone-pad"
											maxLength={15}
											autoComplete="off"
											autoCorrect={false}
											editable={!action.busy}
										/>
										<NativeButton
											label={copy.requestCode}
											disabled={
												!ready || action.busy || !phone || Boolean(whatsappPhoneNumberError(phone))
											}
											onPress={() => {
												const value = phone;
												void run((signal) => whatsapp.pairingCode(session.id, value, signal));
											}}
										/>
									</WebView>
								) : null}
							</>
						) : null}
						{session.state !== "connected" ? (
							<NativeButton
								label={t("whatsapp.check")}
								disabled={!ready || action.busy}
								onPress={() => void run((signal) => whatsapp.get(session.id, signal))}
							/>
						) : (
							<NativeButton
								label={t("whatsapp.review")}
								disabled={action.busy}
								onPress={() => router.replace("/channels")}
							/>
						)}
						{session.state === "expired" ||
						session.state === "error" ||
						session.state === "canceled" ? (
							<NativeButton
								label={t("whatsapp.retry")}
								disabled={!ready || action.busy}
								onPress={() => void run((signal) => whatsapp.retry(session.id, signal))}
							/>
						) : null}
						{whatsappOnboardingRequiresCleanup(session.state) ? (
							<NativeButton
								label={t("whatsapp.cancel")}
								disabled={!ready || action.busy}
								onPress={() => void run((signal) => whatsapp.cancel(session.id, signal))}
							/>
						) : null}
					</>
				)}
				{action.error || pollError ? (
					<AppText accessibilityRole="alert">{t("whatsapp.failed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
