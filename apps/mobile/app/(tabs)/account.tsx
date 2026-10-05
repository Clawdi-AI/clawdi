import { generalPanelClasses } from "@clawdi/shared/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { isDevAuthBypass, useAuthActions } from "../../src/auth/auth-client";
import { useAuthAction } from "../../src/auth/use-auth-action";
import { useI18n } from "../../src/i18n";
import { clearAccountScope, useAccountScope } from "../../src/platform/account-lifecycle";
import { Button } from "../../src/ui/button";
import { GeneralPanel } from "../../src/ui/settings/general-panel";
import { SettingsSection } from "../../src/ui/settings/section";
import { SettingsShell } from "../../src/ui/settings/shell";
import { Text } from "../../src/ui/text";
import { WebView } from "../../src/ui/web-layout";

export default function AccountRoute() {
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const { signOut } = useAuthActions();
	const queries = useQueryClient();
	const router = useRouter();
	const leave = () =>
		void action.run(async (current) => {
			if (!scope.sessionId || !scope.isCurrent()) return;
			await signOut({ sessionId: scope.sessionId });
			const wasCurrent = scope.isCurrent();
			clearAccountScope(scope, queries);
			if (current() && wasCurrent) router.replace("/(auth)/sign-in");
		});
	return (
		<SettingsShell>
			<GeneralPanel />
			<WebView recipe={generalPanelClasses.panel} className="pt-8">
				<SettingsSection title={t("account.more")}>
					<Button variant="ghost" onPress={() => router.push("/ai-providers")}>
						<Text>{t("providers.title")}</Text>
					</Button>
					<Button variant="ghost" onPress={() => router.push("/channels")}>
						<Text>{t("channels.title")}</Text>
					</Button>
					<Button
						variant="outline"
						disabled={isDevAuthBypass() || action.busy || !scope.isReady || !scope.sessionId}
						onPress={leave}
					>
						<Text>{t("account.signOut")}</Text>
					</Button>
					{action.error ? (
						<Text accessibilityRole="alert">{t("account.signOutFailed")}</Text>
					) : null}
				</SettingsSection>
			</WebView>
		</SettingsShell>
	);
}
