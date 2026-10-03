import { useClerk, useUser } from "@clerk/expo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useAuthAction } from "../../src/auth/use-auth-action";
import { useI18n } from "../../src/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../src/platform/account-lifecycle";
import { useMobileApi } from "../../src/providers/api-provider";
import { LoadingScreen } from "../../src/ui/feedback";
import { NativeButton } from "../../src/ui/native-controls";
import { AppText, AppView } from "../../src/ui/primitives";

export default function AccountRoute() {
	const t = useI18n();
	const { isLoaded, user } = useUser();
	const { signOut } = useClerk();
	const scope = useAccountScope();
	const queryClient = useQueryClient();
	const router = useRouter();
	const { account } = useMobileApi();
	const read = useAccountRead();
	const keys = useQuery({
		queryKey: accountQueryKey(scope, "account-api-keys"),
		queryFn: ({ signal }) => read((readSignal) => account.listApiKeys(readSignal), signal),
		enabled: scope.isReady,
		retry: false,
	});
	const { busy, error, run } = useAuthAction(scope.identity);
	const email = user?.primaryEmailAddress?.emailAddress;
	const onSignOut = () =>
		run(async (isCurrent) => {
			if (!scope.sessionId || !scope.isCurrent()) return;
			await signOut({ sessionId: scope.sessionId });
			// Invalidate only the captured account; another account may now be active.
			const wasCurrent = scope.isCurrent();
			scope.abort();
			queryClient.removeQueries({
				predicate: ({ queryKey }) =>
					queryKey[0] === "account" &&
					queryKey[1] === (scope.accountKey ?? "signed-out") &&
					queryKey[2] === scope.generation,
			});
			if (isCurrent() && wasCurrent) router.replace("/(auth)/sign-in");
		});
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	return (
		<AppView className="flex-1 gap-8 bg-background px-6 pb-10 pt-8">
			<AppText className="text-3xl font-semibold text-foreground">{t("account.title")}</AppText>
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText className="text-sm text-muted">{t("account.signedInAs")}</AppText>
				<AppText className="text-lg font-semibold text-foreground">
					{isLoaded && email ? email : t("account.accountUnavailable")}
				</AppText>
			</AppView>
			<NativeButton label={t("navigation.billing")} onPress={() => router.push("/billing")} />
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText className="text-sm text-muted">{t("account.apiKeys")}</AppText>
				{keys.data?.length ? (
					keys.data.map((key) => (
						<AppText className="text-sm text-foreground" key={key.id}>
							{key.label} · {key.key_prefix}
						</AppText>
					))
				) : (
					<AppText className="text-sm text-muted">{t("account.noApiKeys")}</AppText>
				)}
			</AppView>
			{error ? (
				<AppText className="text-base text-danger">{t("account.signOutFailed")}</AppText>
			) : null}
			<NativeButton
				label={busy ? t("auth.working") : t("account.signOut")}
				onPress={() => void onSignOut()}
				disabled={busy || !scope.isReady || !scope.sessionId}
			/>
		</AppView>
	);
}
