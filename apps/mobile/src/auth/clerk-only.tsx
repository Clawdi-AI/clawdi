import { ShieldCheck } from "lucide-react-native";
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { EmptyState } from "../ui/empty-state";
import { ReadScreen } from "../ui/read-screen";
import { SettingsBackButton } from "../ui/settings/back-button";
import { AppView } from "../ui/view";
import { isDevAuthBypass } from "./auth-client";

/** Do not mount Clerk hooks when the real dashboard uses the local dev identity. */
export function ClerkOnly({ children }: { children: ReactNode }) {
	const t = useI18n();
	if (isDevAuthBypass())
		return (
			<ReadScreen>
				<AppView className="px-5 pt-4">
					<SettingsBackButton />
				</AppView>
				<EmptyState
					icon={ShieldCheck}
					title={t("auth.devBypassUnavailable")}
					description={t("auth.devBypassDescription")}
				/>
			</ReadScreen>
		);
	return children;
}
