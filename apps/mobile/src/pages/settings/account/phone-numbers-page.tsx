import { useI18n } from "@/lib/i18n";
import { PhoneNumbersScreen } from "@/platform/account/account-contacts";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("phones.title")} />
			<ClerkOnly>
				<PhoneNumbersScreen />
			</ClerkOnly>
		</>
	);
}
