import { useClerk, useUser } from "@clerk/expo";
import type { SessionWithActivitiesResource } from "@clerk/expo/types";
import { Redirect, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { DeviceSessionsFormView } from "@/components/settings/account-forms";
import { LoadingScreen } from "@/components/ui/feedback";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { readDeviceSessions } from "@/platform/auth/device-sessions";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useNativeReverification } from "@/platform/auth/use-native-reverification";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function DeviceSessionsScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/sign-in" />;
	return <DeviceSessions key={`${scope.identity}:${scope.generation}`} />;
}

function DeviceSessions() {
	const t = useI18n();
	const clerk = useClerk();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const confirmationDialog = useConfirmation();
	const [sessions, setSessions] = useState<SessionWithActivitiesResource[] | null>(null);
	const [revoked, setRevoked] = useState(false);
	useFocusEffect(
		useCallback(
			() => () => {
				setSessions(null);
				setRevoked(false);
			},
			[],
		),
	);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				setSessions(null);
				setRevoked(false);
			}
		});
		return () => listener.remove();
	}, []);
	const load = async (current: () => boolean) => {
		if (!clerk.client || !scope.accountKey || !scope.sessionId)
			throw new Error("Account unavailable");
		return readDeviceSessions(clerk.client, scope.accountKey, scope.sessionId, current);
	};
	const run = (work: (current: () => boolean) => Promise<void>, propagate = false) =>
		(propagate ? action.runOrThrow : action.run)(async (active) => {
			const visible = capture();
			const current = () => active() && scope.isCurrent() && visible();
			if (!current()) return;
			setRevoked(false);
			await work(current);
		});
	const refresh = () =>
		run(async (current) => {
			setSessions(null);
			const rows = await load(current);
			if (current()) setSessions(rows);
		});
	const revoke = (id: string) => {
		if (id === scope.sessionId) return;
		const visible = capture();
		const ticket = ++confirmation.current;
		confirmationDialog.show(t("devices.revoke"), t("devices.warning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("devices.revoke"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					return run(
						async (current) =>
							reverification.execute(async () => {
								if (!current() || id === scope.sessionId) throw new Error("Account action retired");
								const rows = await load(current);
								const target = rows.find((row) => row.id === id);
								if (!current()) return;
								setSessions(rows);
								if (target) {
									const result = await target.revoke();
									if (!current()) return;
									if (result.id !== id || result.status !== "revoked")
										throw new Error("Revocation not confirmed");
								}
								const remaining = await load(current);
								if (!current()) return;
								if (remaining.some((row) => row.id === id)) throw new Error("Session still active");
								setSessions(remaining);
								setRevoked(true);
							}),
						true,
					);
				},
			},
		]);
	};
	return (
		<>
			{confirmationDialog.dialog}
			<DeviceSessionsFormView
				action={action}
				reverification={reverification}
				sessions={sessions}
				scope={scope}
				revoked={revoked}
				refresh={refresh}
				revoke={revoke}
			/>
		</>
	);
}
