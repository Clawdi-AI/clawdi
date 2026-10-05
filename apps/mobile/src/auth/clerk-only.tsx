import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { EmptyState } from "../ui/empty-state";
import { AppView } from "../ui/view";
import { isDevAuthBypass } from "./auth-client";

/** Do not mount Clerk hooks when the real dashboard uses the local dev identity. */
export function ClerkOnly({ children }: { children: ReactNode }) {
	const t = useI18n();
	if (isDevAuthBypass()) {
		return (
			<AppView className="flex-1 bg-background px-6">
				<EmptyState title={t("auth.devBypassUnavailable")} />
			</AppView>
		);
	}
	return children;
}
