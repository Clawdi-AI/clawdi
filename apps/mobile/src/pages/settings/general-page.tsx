import { generalPanelClasses } from "@clawdi/shared/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { LogOut } from "lucide-react-native";
import { GeneralPanel } from "@/components/settings/general-panel";
import { SettingsShell } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { clearAccountScope, useAccountScope } from "@/platform/account-lifecycle";
import { isDevAuthBypass, useAuthActions } from "@/platform/auth/auth-client";
import { useAuthAction } from "@/platform/auth/use-auth-action";

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
			if (current() && wasCurrent) router.replace("/sign-in");
		});
	return (
		<SettingsShell>
			<GeneralPanel />
			<WebView recipe={generalPanelClasses.panel} className="pt-8">
				<Button
					variant="outline"
					disabled={isDevAuthBypass() || action.busy || !scope.isReady || !scope.sessionId}
					onPress={leave}
				>
					<Icon as={LogOut} />
					<Text>{t("account.signOut")}</Text>
				</Button>
				{action.error ? <Text accessibilityRole="alert">{t("account.signOutFailed")}</Text> : null}
			</WebView>
		</SettingsShell>
	);
}
