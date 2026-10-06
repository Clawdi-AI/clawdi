import { useUser } from "@clerk/expo";
import type { UserResource } from "@clerk/expo/types";
import { Redirect } from "expo-router";
import { useRef, useState } from "react";
import { PasskeysFormView } from "@/components/settings/account-forms";
import { LoadingScreen } from "@/components/ui/feedback";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useNativeReverification } from "@/platform/auth/use-native-reverification";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function PasskeysScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/sign-in" />;
	return <Passkeys key={`${scope.identity}:${scope.generation}`} user={user} />;
}

type Change = { kind: "rename"; id: string; name: string } | { kind: "remove"; id: string };

function Passkeys({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const confirmation = useRef(0);
	const confirmationDialog = useConfirmation();
	const [passkeys, setPasskeys] = useState([...user.passkeys]);
	const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
	const [saved, setSaved] = useState(false);
	const run = (change?: Change, propagate = false) =>
		(propagate ? action.runOrThrow : action.run)(async (active) => {
			const visible = capture();
			const signal = scope.signal;
			const current = () =>
				active() &&
				visible() &&
				!signal.aborted &&
				scope.isCurrent() &&
				user.id === scope.accountKey;
			if (!current()) return;
			setSaved(false);
			await reverification.execute(async () => {
				if (!current()) throw new Error("Account action retired");
				const refreshed = await user.reload();
				if (!current()) return;
				if (refreshed.id !== scope.accountKey) throw new Error("Account identity changed");
				setPasskeys([...refreshed.passkeys]);
				if (!change) return;
				const passkey = refreshed.passkeys.find((value) => value.id === change.id);
				if (change.kind === "rename") {
					const name = change.name.trim();
					if (!passkey || !name) throw new Error("Passkey unavailable or name missing");
					// A retry first reads current state, avoiding an unnecessary repeated mutation.
					if (passkey.name !== name) {
						const updated = await passkey.update({ name });
						if (!current()) return;
						if (updated.id !== change.id || updated.name !== name)
							throw new Error("Passkey rename not confirmed");
					}
				} else if (passkey) {
					await passkey.delete();
					if (!current()) return;
				}
				const confirmed = await user.reload();
				if (!current()) return;
				if (confirmed.id !== scope.accountKey) throw new Error("Account identity changed");
				setPasskeys([...confirmed.passkeys]);
				const remaining = confirmed.passkeys.find((value) => value.id === change.id);
				if (change.kind === "remove" ? Boolean(remaining) : remaining?.name !== change.name.trim())
					throw new Error("Passkey change not confirmed");
				setEdit(null);
				setSaved(true);
			});
		});
	const confirmRemove = (id: string) => {
		const visible = capture();
		const signal = scope.signal;
		const ticket = ++confirmation.current;
		confirmationDialog.show(t("passkeys.remove"), t("passkeys.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("passkeys.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || signal.aborted || !scope.isCurrent())
						return;
					return run({ kind: "remove", id }, true);
				},
			},
		]);
	};
	return (
		<>
			{confirmationDialog.dialog}
			<PasskeysFormView
				action={action}
				reverification={reverification}
				passkeys={passkeys}
				edit={edit}
				saved={saved}
				setEdit={setEdit}
				setSaved={setSaved}
				run={run}
				confirmRemove={confirmRemove}
			/>
		</>
	);
}
