import {
	codexDeviceVerificationUrl,
	codexProviderBody,
	type components,
	devicePollDelay,
	providerFormIdentity,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import { providerDialogClasses, providerOAuthFlowClasses as styles } from "@clawdi/shared/ui";
import { providerOAuthCopy as copy } from "@clawdi/shared/view";
import { onlineManager } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ActionButton } from "@/components/dashboard/controls";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Button } from "@/components/ui/button";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText, Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import {
	useProviderInventory,
	useRefreshProviders,
} from "@/hosted/v2/ai-providers/providers-hooks";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type Authorization = components["schemas"]["AiProviderOAuthDeviceStartResponse"];
type AcceptBody = components["schemas"]["AiProviderAcceptRequest"];

export function ProviderOAuthFlow({
	providers,
	provider,
	refresh,
	label = "",
	startLabel,
	startIcon,
	dialogFooter = false,
	onBusyChange,
}: {
	providers?: SavedAiProvider[];
	provider?: SavedAiProvider;
	refresh: () => Promise<void>;
	label?: string;
	startLabel?: string;
	startIcon?: ReactNode;
	dialogFooter?: boolean;
	onBusyChange?: (busy: boolean) => void;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
	useEffect(() => {
		onBusyChange?.(action.busy);
		return () => onBusyChange?.(false);
	}, [action.busy, onBusyChange]);
	const [authorization, setAuthorization] = useState<Authorization | null>(null);
	const [issue, setIssue] = useState<"failed" | "expired" | null>(null);
	const [ready, setReady] = useState(false);
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(AppState.currentState === "active");
	const [online, setOnline] = useState(onlineManager.isOnline());
	const [retry, setRetry] = useState(0);
	const [lifecycleVersion, setLifecycleVersion] = useState(0);
	const generation = useRef(0);
	const nextPollAt = useRef(0);
	const acceptAttempt = useRef<{ body: AcceptBody; key: string } | null>(null);
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useFocusEffect(
		useCallback(() => {
			setFocused(true);
			return () => {
				generation.current++;
				setLifecycleVersion((value) => value + 1);
				setFocused(false);
			};
		}, []),
	);
	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				generation.current++;
				setLifecycleVersion((value) => value + 1);
			}
			setActive(state === "active");
		});
		const unsubscribe = onlineManager.subscribe((value) => {
			if (!value) {
				generation.current++;
				setLifecycleVersion((version) => version + 1);
			}
			setOnline(value);
		});
		return () => {
			subscription.remove();
			unsubscribe();
		};
	}, []);
	const stop = () => {
		generation.current++;
		setAuthorization(null);
		setIssue(null);
		acceptAttempt.current = null;
	};
	const begin = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!visible() || (!provider && !providers)) return;
			const lease = ++generation.current;
			setAuthorization(null);
			setIssue(null);
			setReady(false);
			let result: Authorization;
			if (provider) {
				result = await read((signal) =>
					aiProviders.startDeviceAuthorization(provider.provider_id, signal),
				);
			} else {
				let attempt = acceptAttempt.current;
				if (!attempt) {
					const identity = providerFormIdentity({
						type: "openai",
						authMethod: "oauth",
						labelInput: label,
						existingProviderIds: (providers ?? []).map((item) => item.provider_id),
					});
					attempt = {
						key: randomUUID(),
						body: {
							provider: codexProviderBody(identity),
							credential: { type: "oauth", provider: "codex", flow: "device_code" },
							replace: false,
						},
					};
					acceptAttempt.current = attempt;
				}
				const submitting = attempt;
				const accepted = await read((signal) =>
					aiProviders.accept(submitting.body, submitting.key, signal),
				);
				if (!current() || !visible() || generation.current !== lease) return;
				if (accepted.status === "ready") {
					acceptAttempt.current = null;
					setReady(true);
					await refreshRef.current();
					return;
				}
				result = accepted.authorization;
				if (result.provider_id !== accepted.provider.provider_id)
					throw new Error("Invalid provider identity");
			}
			if (!current() || !visible() || generation.current !== lease) return;
			const remaining = Date.parse(result.expires_at) - Date.now();
			codexDeviceVerificationUrl(result.verification_url);
			if (
				result.flow !== "device_code" ||
				result.oauth_provider !== "codex" ||
				typeof result.state !== "string" ||
				!result.state ||
				typeof result.user_code !== "string" ||
				!result.user_code ||
				typeof result.provider_id !== "string" ||
				!result.provider_id ||
				!Number.isFinite(remaining) ||
				remaining <= 0 ||
				remaining > 86400000 ||
				(provider && result.provider_id !== provider.provider_id)
			)
				throw new Error("Invalid device authorization");
			nextPollAt.current = Date.now() + devicePollDelay(result.poll_interval_seconds);
			setAuthorization(result);
			await refreshRef.current();
		});
	useEffect(() => {
		if (!authorization) return;
		const timer = setTimeout(
			() => setIssue("expired"),
			Math.max(0, Date.parse(authorization.expires_at) - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [authorization]);
	useEffect(() => {
		if (!authorization || !active || !focused || !online || issue) return;
		const controller = new AbortController();
		const lease = generation.current;
		const current = () =>
			!controller.signal.aborted &&
			generation.current === lease &&
			scope.isCurrent() &&
			AppState.currentState === "active" &&
			onlineManager.isOnline();
		const deadline = Date.parse(authorization.expires_at);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failures = 0;
		const schedule = () => {
			if (!current()) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				setIssue("expired");
				return;
			}
			timer = setTimeout(
				() => void poll(),
				Math.min(remaining, Math.max(0, nextPollAt.current - Date.now())),
			);
		};
		const poll = async () => {
			if (!current()) return;
			if (Date.now() >= deadline) {
				setIssue("expired");
				return;
			}
			try {
				const result = await read(
					(signal) =>
						aiProviders.pollDeviceAuthorization(
							authorization.provider_id,
							authorization.state,
							signal,
						),
					controller.signal,
				);
				if (!current()) return;
				if (result.status === "ready") {
					if (result.provider.provider_id !== authorization.provider_id)
						throw new Error("Invalid provider identity");
					generation.current++;
					acceptAttempt.current = null;
					setAuthorization(null);
					setReady(true);
					await refreshRef.current();
					return;
				}
				nextPollAt.current = Date.now() + devicePollDelay(result.retry_after_seconds);
				failures = 0;
			} catch {
				if (!current()) return;
				if (++failures >= 3) {
					setIssue("failed");
					return;
				}
				nextPollAt.current = Date.now() + devicePollDelay(authorization.poll_interval_seconds);
			}
			schedule();
		};
		schedule();
		return () => {
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [
		authorization,
		active,
		focused,
		online,
		issue,
		retry,
		lifecycleVersion,
		read,
		aiProviders,
		scope,
	]);
	if (dialogFooter && !authorization)
		return (
			<WebView recipe={providerDialogClasses.footer}>
				{ready ? <AppText accessibilityRole="alert">{t("providers.oauthReady")}</AppText> : null}
				{action.error ? (
					<WebText recipe={styles.error} accessibilityRole="alert">
						{t("providers.failed")}
					</WebText>
				) : null}
				<Button
					disabled={action.busy || !scope.isReady || !online || (!provider && !providers)}
					onPress={() => void begin()}
				>
					{startIcon}
					<Text>
						{startLabel ?? t(provider ? "providers.reconnectOAuth" : "providers.connectOAuth")}
					</Text>
				</Button>
			</WebView>
		);
	return (
		<WebView recipe={dialogFooter ? `${providerDialogClasses.body} ${styles.root}` : styles.root}>
			{!authorization ? (
				<ActionButton
					label={startLabel ?? t(provider ? "providers.reconnectOAuth" : "providers.connectOAuth")}
					icon={startIcon}
					disabled={action.busy || !scope.isReady || !online || (!provider && !providers)}
					onPress={() => void begin()}
				/>
			) : (
				<>
					<WebView recipe={styles.tile}>
						<WebText recipe={styles.label}>{copy.code}</WebText>
						<WebView recipe={styles.codeRow}>
							<WebText recipe={styles.code} selectable>
								{authorization.user_code}
							</WebText>
						</WebView>
					</WebView>
					<ActionButton
						label={copy.open}
						disabled={action.busy || issue === "expired"}
						onPress={() =>
							void action.run(async () => {
								if (!scope.isCurrent() || !capture()()) return;
								await Linking.openURL(codexDeviceVerificationUrl(authorization.verification_url));
							})
						}
					/>
					{issue === "failed" ? (
						<ActionButton
							label={copy.restart}
							disabled={!online}
							onPress={() => {
								setIssue(null);
								setRetry((value) => value + 1);
							}}
						/>
					) : null}
					{issue ? (
						<WebText recipe={styles.error} accessibilityRole="alert">
							{issue === "expired" ? copy.expired : copy.failed}
						</WebText>
					) : (
						<WebText recipe={styles.waiting}>{copy.waiting}</WebText>
					)}
					{!online ? <AppText>{t("providers.oauthOffline")}</AppText> : null}
					<ActionButton label={t("providers.stopOAuth")} onPress={stop} />
				</>
			)}
			{ready ? <AppText accessibilityRole="alert">{t("providers.oauthReady")}</AppText> : null}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</WebView>
	);
}

export function ProviderOAuth({
	provider,
}: {
	provider?: SavedAiProvider;
	refresh: () => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	return (
		<ActionButton
			label={t("providers.reconnectOAuth")}
			disabled={!scope.isReady || !provider}
			onPress={() => {
				if (provider)
					router.push({
						pathname: "/ai-providers/[providerId]/oauth",
						params: { providerId: provider.provider_id },
					});
			}}
		/>
	);
}
export function ProviderOAuthScreen() {
	const t = useI18n();
	const scope = useAccountScope();
	const { providerId } = useLocalSearchParams<{ providerId: string }>();
	const inventory = useProviderInventory();
	const refresh = useRefreshProviders();
	const [busy, setBusy] = useState(false);
	const provider = inventory.isError
		? undefined
		: inventory.data?.providers.find((item) => item.provider_id === providerId);
	return (
		<SheetPage title={t("providers.reconnectOAuth")} fallback="/ai-providers" busy={busy}>
			{inventory.isPending ? (
				<RouteLoadingSkeleton />
			) : inventory.isError ? (
				<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
			) : provider &&
				(provider.auth.type === "oauth_profile" || provider.auth.type === "agent_profile") ? (
				<ProviderOAuthFlow
					key={`${scope.accountKey}:${scope.generation}:${providerId}`}
					provider={provider}
					refresh={refresh}
					onBusyChange={setBusy}
				/>
			) : (
				<ResourceError missing />
			)}
		</SheetPage>
	);
}
