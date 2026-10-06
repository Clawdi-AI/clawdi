import { ShieldCheck } from "lucide-react-native";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { SettingsBackButton } from "@/components/settings/back-button";
import { AppView } from "@/components/ui/view";
import { useI18n } from "@/lib/i18n";
import { isDevAuthBypass } from "@/platform/auth/auth-client";
import { ReadScreen } from "@/platform/safe-area-screen";

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
