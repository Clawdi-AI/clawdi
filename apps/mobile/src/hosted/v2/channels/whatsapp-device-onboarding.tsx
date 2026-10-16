import {
	pairCodeExpired,
	redactWhatsAppSession,
	type WhatsAppSession,
	whatsappOnboardingRequiresCleanup,
	whatsappOnboardingShouldPoll,
	whatsappPhoneNumberError,
} from "@clawdi/shared/api";
import { pairingQr } from "@clawdi/shared/qr";
import { whatsappDeviceOnboardingClasses as styles } from "@clawdi/shared/ui";
import {
	channelFormCopy,
	whatsappOnboardingCopy as copy,
	whatsappReadinessMessage,
} from "@clawdi/shared/view";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import QrCode from "lucide-react-native/icons/qr-code";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { ActionButton } from "@/components/dashboard/controls";
import { Alert } from "@/components/ui/alert";
import { Icon } from "@/components/ui/icon";
import { Input as AppTextInput, Label } from "@/components/ui/input";
import { QrImage } from "@/components/ui/qr-image";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useChannelQuery } from "@/hosted/v2/channels/channels-hooks";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

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
	const [configuring, setConfiguring] = useState(false);
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
		<SheetPage
			title={accountId ? channelFormCopy.repairTitle : channelFormCopy.whatsappTitle}
			fallback="/channels"
			busy={action.busy}
		>
			{!accountId && !session && !configuring ? (
				<WebView recipe={styles.accountChoice}>
					<WebText recipe={styles.description}>{copy.accountDescription}</WebText>
					<Alert icon={TriangleAlert} title={copy.warningTitle} className={webView(styles.warning)}>
						<WebText recipe={styles.warningDescription}>{copy.warningDescription}</WebText>
					</Alert>
					<WebText recipe={styles.readiness} accessibilityRole="text">
						{readiness.isPending
							? copy.checking
							: whatsappReadinessMessage(readiness.data, readiness.isError)}
					</WebText>
					<ActionButton
						label={copy.connectAccount}
						variant="default"
						className={webView(styles.connectAction)}
						icon={<Icon as={QrCode} className={webBoth(styles.connectIcon)} />}
						disabled={!ready || readiness.isPending || action.busy}
						onPress={() => setConfiguring(true)}
					/>
					<WebText recipe={styles.description}>{copy.accountNextSteps}</WebText>
				</WebView>
			) : (
				<>
					{!accountId ? (
						<Alert
							icon={TriangleAlert}
							title={copy.warningTitle}
							className={webView(styles.warning)}
						>
							<WebText recipe={styles.warningDescription}>{copy.warningDescription}</WebText>
						</Alert>
					) : null}
					{/* Platform: leaving the app pauses status checks. */}
					<WebText recipe={styles.hint}>{t("whatsapp.leaving")}</WebText>
					{!session ? (
						<>
							{!ready && !accountId ? (
								<AppText>{whatsappReadinessMessage(readiness.data, readiness.isError)}</AppText>
							) : null}
							{!accountId ? (
								<WebView recipe={styles.nameField}>
									<Label>{copy.accountName}</Label>
									<AppTextInput
										accessibilityLabel={copy.accountName}
										placeholder={copy.accountPlaceholder}
										value={name}
										onChangeText={setName}
										editable={!attempt.current && !action.busy}
										maxLength={120}
									/>
									<WebText recipe={styles.hint}>{copy.nameHint}</WebText>
								</WebView>
							) : null}
							<ActionButton
								label={action.busy ? copy.starting : copy.generateQr}
								variant="default"
								icon={<Icon as={QrCode} />}
								disabled={!ready || action.busy || (!accountId && !name.trim())}
								onPress={() =>
									void run((signal) => {
										if (accountId) return whatsapp.repair(accountId, signal);
										const saved = attempt.current ?? { id: randomUUID(), name: name.trim() };
										attempt.current = saved;
										return whatsapp.start(saved.id, saved.name, signal);
									})
								}
							/>
						</>
					) : (
						<WhatsAppSessionView
							session={session}
							expired={expired}
							qr={qr}
							focused={focused}
							active={active}
							phone={phone}
							setPhone={setPhone}
							ready={Boolean(ready)}
							busy={action.busy}
							requestCode={() => {
								const value = phone;
								void run((signal) => whatsapp.pairingCode(session.id, value, signal));
							}}
							repairing={Boolean(accountId)}
							review={() => router.replace("/channels")}
							retry={() => void run((signal) => whatsapp.retry(session.id, signal))}
							cancel={() => void run((signal) => whatsapp.cancel(session.id, signal))}
						/>
					)}
					{pollError ? (
						<WebText recipe="text-xs text-warning">{copy.statusCheckFailed}</WebText>
					) : null}
					{action.error ? (
						<Alert
							variant="destructive"
							title={
								session
									? copy.actionFailedTitle
									: accountId
										? copy.repairFailedTitle
										: copy.startFailedTitle
							}
						>
							{session ? copy.actionFailed : accountId ? copy.repairFailed : copy.startFailed}
						</Alert>
					) : null}
				</>
			)}
		</SheetPage>
	);
}

export function WhatsAppSessionView({
	session,
	expired,
	qr,
	focused,
	active,
	phone,
	setPhone,
	ready,
	busy,
	requestCode,
	repairing,
	review,
	retry,
	cancel,
}: {
	session: WhatsAppSession;
	expired: boolean;
	qr: ReturnType<typeof pairingQr> | null;
	focused: boolean;
	active: boolean;
	phone: string;
	setPhone: (value: string) => void;
	ready: boolean;
	busy: boolean;
	requestCode: () => void;
	repairing: boolean;
	review: () => void;
	retry: () => void;
	cancel: () => void;
}) {
	// Web's WhatsAppSessionState: a title and description for every non-ready state.
	const state =
		expired && whatsappOnboardingShouldPoll(session.state)
			? { title: copy.expired, description: copy.expiredDescription }
			: session.state === "generating"
				? { title: copy.generating }
				: session.state === "scanned"
					? { title: copy.scanned, description: copy.scannedDescription }
					: session.state === "connected"
						? {
								title: copy.connected,
								description: repairing ? copy.reconnectedDescription : copy.connectedDescription,
							}
						: session.state === "expired"
							? { title: copy.expired, description: copy.expiredDescription }
							: session.state === "canceled"
								? { title: copy.canceled }
								: session.state === "error"
									? { title: copy.error, description: copy.errorDescription }
									: null;
	return (
		<>
			{state ? (
				<WebView recipe={styles.centeredState}>
					<WebText recipe={styles.stateTitle}>{state.title}</WebText>
					{state.description ? <WebText recipe={styles.hint}>{state.description}</WebText> : null}
				</WebView>
			) : null}
			{qr ? (
				<AppView className="items-center">
					<QrImage matrix={qr} label={copy.qrLabel} size={176} />
				</AppView>
			) : null}
			{session.state === "ready" && !expired ? (
				focused && active && session.method === "code" && session.pairing_code ? (
					<>
						<WebText recipe={styles.pairingCodeTitle}>{copy.codeTitle}</WebText>
						<WebText recipe={styles.hint}>{copy.codeSteps}</WebText>
						<AppText selectable className="text-2xl font-semibold text-foreground">
							{session.pairing_code}
						</AppText>
						<WebText recipe={styles.hint}>{copy.codeHint}</WebText>
					</>
				) : (
					<>
						{!qr && session.method === "qr" ? (
							<WebView recipe={styles.centeredState}>
								<WebText recipe={styles.stateTitle}>{copy.refreshingQr}</WebText>
							</WebView>
						) : null}
						<WebText recipe={styles.pairingCodeTitle}>{copy.qrHeading}</WebText>
						<WebText recipe={styles.hint}>{copy.scanInstruction}</WebText>
						<WebText recipe={styles.hint}>{copy.phoneWarning}</WebText>
						{session.manual_pairing_code_supported && session.method !== "code" ? (
							<WebView recipe={styles.fallback}>
								<WebText recipe={styles.pairingCodeTitle}>{copy.fallback}</WebText>
								<WebText recipe={styles.hint}>{copy.phoneHint}</WebText>
								<Label>{copy.phoneLabel}</Label>
								<AppTextInput
									accessibilityLabel={copy.phoneLabel}
									placeholder={copy.phonePlaceholder}
									value={phone}
									onChangeText={setPhone}
									keyboardType="phone-pad"
									maxLength={15}
									autoComplete="off"
									autoCorrect={false}
									editable={!busy}
								/>
								{whatsappPhoneNumberError(phone) ? (
									<WebText recipe="text-xs text-destructive">
										{whatsappPhoneNumberError(phone)}
									</WebText>
								) : null}
								<ActionButton
									label={busy ? copy.requesting : copy.requestCode}
									disabled={!ready || busy || !phone || Boolean(whatsappPhoneNumberError(phone))}
									onPress={requestCode}
								/>
							</WebView>
						) : null}
					</>
				)
			) : null}
			{session.state === "connected" ? (
				<ActionButton
					label={repairing ? copy.done : copy.reviewBots}
					variant="default"
					disabled={busy}
					onPress={review}
				/>
			) : null}
			{session.state === "expired" || session.state === "error" || session.state === "canceled" ? (
				<ActionButton label={copy.retry} disabled={!ready || busy} onPress={retry} />
			) : null}
			{whatsappOnboardingRequiresCleanup(session.state) ? (
				<ActionButton
					label={busy ? copy.canceling : copy.cancelConnection}
					disabled={!ready || busy}
					onPress={cancel}
				/>
			) : null}
		</>
	);
}
