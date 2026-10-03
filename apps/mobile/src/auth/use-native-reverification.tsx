import { useReverification, useSession } from "@clerk/expo";
import type { SessionVerificationResource } from "@clerk/expo/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { useAuthAction } from "./use-auth-action";

type Options = NonNullable<Parameters<typeof useReverification>[1]>;
type Request = Parameters<NonNullable<Options["onNeedsReverification"]>>[0];
type First = NonNullable<SessionVerificationResource["supportedFirstFactors"]>[number];
type Second = NonNullable<SessionVerificationResource["supportedSecondFactors"]>[number];
type Factor = Extract<
	First | Second,
	{ strategy: "password" | "email_code" | "phone_code" | "totp" | "backup_code" }
>;

function supported(factor: First | Second): factor is Factor {
	return (
		factor.strategy === "password" ||
		factor.strategy === "email_code" ||
		factor.strategy === "phone_code" ||
		factor.strategy === "totp" ||
		factor.strategy === "backup_code"
	);
}

/** Native UI for Clerk's assurance challenge; no credential persistence or implicit policy bypass. */
export function useNativeReverification() {
	const t = useI18n();
	const scope = useAccountScope();
	const { session } = useSession();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const pending = useRef<Request | null>(null);
	const operation = useRef<(() => boolean) | null>(null);
	const [request, setRequest] = useState<Request | null>(null);
	const [attempt, setAttempt] = useState<SessionVerificationResource | null>(null);
	const [factor, setFactor] = useState<Factor | null>(null);
	const [secret, setSecret] = useState("");
	const reset = useCallback(() => {
		setRequest(null);
		setAttempt(null);
		setFactor(null);
		setSecret("");
	}, []);
	const cancel = useCallback(() => {
		const previous = pending.current;
		pending.current = null;
		reset();
		previous?.cancel();
	}, [reset]);
	useFocusEffect(useCallback(() => cancel, [cancel]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") cancel();
		});
		return () => listener.remove();
	}, [cancel]);
	useEffect(() => cancel, [scope.identity, cancel]);
	const execute = useReverification(async (work: () => Promise<void>) => work(), {
		onNeedsReverification: (next) => {
			if (
				!operation.current?.() ||
				!scope.isCurrent() ||
				!capture()() ||
				!session ||
				session.id !== scope.sessionId ||
				pending.current
			) {
				next.cancel();
				return;
			}
			pending.current = next;
			setRequest(next);
			setAttempt(null);
			setFactor(null);
			setSecret("");
			action.clearError();
		},
	});
	const run = (
		work: (
			current: () => boolean,
			accept: (value: SessionVerificationResource) => void,
		) => Promise<void>,
	) =>
		void action.run(async (active) => {
			const expected = pending.current;
			const visible = capture();
			const current = () =>
				active() &&
				visible() &&
				scope.isCurrent() &&
				expected !== null &&
				pending.current === expected &&
				session?.id === scope.sessionId;
			if (!current()) return;
			const accept = (value: SessionVerificationResource) => {
				if (!current()) return;
				if (value.session.id !== scope.sessionId) throw new Error("Verification session mismatch");
				setSecret("");
				if (value.status === "complete") {
					pending.current = null;
					reset();
					expected?.complete();
				} else {
					setAttempt(value);
					setFactor(null);
				}
			};
			await work(current, accept);
		});
	const start = () =>
		run(async (_current, accept) => {
			if (!session || !request) return;
			accept(await session.startVerification({ level: request.level ?? "multi_factor" }));
		});
	const choose = (selected: Factor) =>
		run(async (current, accept) => {
			if (!session || !attempt) return;
			setSecret("");
			let prepared: SessionVerificationResource | undefined;
			if (attempt.status === "needs_first_factor") {
				if (selected.strategy === "email_code")
					prepared = await session.prepareFirstFactorVerification({
						strategy: "email_code",
						emailAddressId: selected.emailAddressId,
					});
				else if (selected.strategy === "phone_code")
					prepared = await session.prepareFirstFactorVerification({
						strategy: "phone_code",
						phoneNumberId: selected.phoneNumberId,
					});
			} else if (selected.strategy === "phone_code") {
				prepared = await session.prepareSecondFactorVerification({
					strategy: "phone_code",
					phoneNumberId: selected.phoneNumberId,
				});
			}
			if (!current()) return;
			if (prepared) {
				accept(prepared);
				if (!current() || prepared.status !== attempt.status) return;
			}
			setFactor(selected);
		});
	const submit = () =>
		run(async (_current, accept) => {
			if (!session || !attempt || !factor || !secret) return;
			if (attempt.status === "needs_first_factor") {
				if (factor.strategy === "password")
					accept(
						await session.attemptFirstFactorVerification({
							strategy: "password",
							password: secret,
						}),
					);
				else if (factor.strategy === "email_code" || factor.strategy === "phone_code")
					accept(
						await session.attemptFirstFactorVerification({
							strategy: factor.strategy,
							code: secret.trim(),
						}),
					);
			} else if (
				factor.strategy === "phone_code" ||
				factor.strategy === "totp" ||
				factor.strategy === "backup_code"
			) {
				accept(
					await session.attemptSecondFactorVerification({
						strategy: factor.strategy,
						code: secret.trim(),
					}),
				);
			}
		});
	const factors =
		(attempt?.status === "needs_first_factor"
			? attempt.supportedFirstFactors
			: attempt?.supportedSecondFactors
		)?.filter(supported) ?? [];
	const prompt = request ? (
		<AppView className="gap-3 rounded-xl bg-surface p-4">
			<AppText accessibilityRole="header">{t("reverification.title")}</AppText>
			<AppText>{t("reverification.description")}</AppText>
			{!attempt ? (
				<NativeButton label={t("reverification.start")} disabled={action.busy} onPress={start} />
			) : null}
			{attempt && factors.length === 0 ? (
				<AppText accessibilityRole="alert">{t("reverification.unsupported")}</AppText>
			) : null}
			{factors.map((item, index) => (
				<NativeButton
					key={`${item.strategy}:${index}`}
					label={`${t(`reverification.${item.strategy}`)}${"safeIdentifier" in item ? ` · ${item.safeIdentifier}` : ""}`}
					disabled={action.busy}
					onPress={() => choose(item)}
				/>
			))}
			{factor ? (
				<>
					<AppText>{t("reverification.inputHint")}</AppText>
					<AppTextInput
						accessibilityLabel={t(`reverification.${factor.strategy}`)}
						value={secret}
						onChangeText={setSecret}
						editable={!action.busy}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						autoComplete={factor.strategy === "password" ? "current-password" : "one-time-code"}
						className="rounded-xl bg-background p-3 text-foreground"
					/>
					<NativeButton
						label={t("reverification.verify")}
						disabled={action.busy || !secret}
						onPress={submit}
					/>
				</>
			) : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("reverification.failed")}</AppText>
			) : null}
			<NativeButton label={t("account.cancel")} onPress={cancel} />
		</AppView>
	) : null;
	return {
		execute: async (work: () => Promise<void>) => {
			if (operation.current) throw new Error("Account operation already pending");
			const visible = capture();
			const lease = () => visible() && scope.isCurrent() && session?.id === scope.sessionId;
			operation.current = lease;
			try {
				const result = await execute(async () => {
					if (!lease()) throw new Error("Account operation retired");
					await work();
				});
				// A second assurance hint is not successful completion of the mutation.
				if (result !== undefined) throw new Error("Reverification still required");
			} finally {
				if (operation.current === lease) operation.current = null;
			}
		},
		prompt,
	};
}
