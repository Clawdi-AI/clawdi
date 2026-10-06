import { useI18n } from "@/lib/i18n";
import { DeleteAccountScreen } from "@/platform/account/delete-account";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("deletion.title")} />
			<ClerkOnly>
				<DeleteAccountScreen />
			</ClerkOnly>
		</>
	);
}
