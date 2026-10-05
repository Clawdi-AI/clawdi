import {
	codexDeviceVerificationUrl,
	codexProviderBody,
	type components,
	devicePollDelay,
	providerFormIdentity,
	type SavedAiProvider,
} from "@clawdi/shared/api";
import { onlineManager } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { ActionButton } from "../ui/agents/controls";
import { AppText, AppView } from "../ui/primitives";

type Authorization = components["schemas"]["AiProviderOAuthDeviceStartResponse"];
type AcceptBody = components["schemas"]["AiProviderAcceptRequest"];

export function ProviderOAuth({
	providers,
	provider,
	refresh,
}: {
	providers?: SavedAiProvider[];
	provider?: SavedAiProvider;
	refresh: () => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
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
						labelInput: "",
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
	return (
		<AppView className="gap-3">
			{!authorization ? (
				<ActionButton
					label={t(provider ? "providers.reconnectOAuth" : "providers.connectOAuth")}
					disabled={action.busy || !scope.isReady || !online || (!provider && !providers)}
					onPress={() => void begin()}
				/>
			) : (
				<>
					<AppText>{t("providers.deviceInstructions")}</AppText>
					<AppText selectable className="text-lg font-semibold text-foreground">
						{authorization.user_code}
					</AppText>
					<ActionButton
						label={t("providers.openAuthorization")}
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
							label={t("providers.resumeOAuth")}
							disabled={!online}
							onPress={() => {
								setIssue(null);
								setRetry((value) => value + 1);
							}}
						/>
					) : null}
					{issue ? (
						<AppText accessibilityRole="alert">
							{t(issue === "expired" ? "providers.oauthExpired" : "providers.failed")}
						</AppText>
					) : null}
					{!online ? <AppText>{t("providers.oauthOffline")}</AppText> : null}
					<ActionButton label={t("providers.stopOAuth")} onPress={stop} />
				</>
			)}
			{ready ? <AppText accessibilityRole="alert">{t("providers.oauthReady")}</AppText> : null}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</AppView>
	);
}
