import { useI18n } from "@/lib/i18n";
import { MfaScreen } from "@/platform/account/mfa";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("mfa.title")} />
			<ClerkOnly>
				<MfaScreen />
			</ClerkOnly>
		</>
	);
}
