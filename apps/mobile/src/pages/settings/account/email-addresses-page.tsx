import { useI18n } from "@/lib/i18n";
import { EmailAddressesScreen } from "@/platform/account/account-contacts";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("emails.title")} />
			<ClerkOnly>
				<EmailAddressesScreen />
			</ClerkOnly>
		</>
	);
}
