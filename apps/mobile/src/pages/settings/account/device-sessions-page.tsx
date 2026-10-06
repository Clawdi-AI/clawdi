import { useI18n } from "@/lib/i18n";
import { DeviceSessionsScreen } from "@/platform/account/device-sessions";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function AccountPage() {
	const t = useI18n();
	return (
		<>
			<NativeHeader title={t("devices.title")} />
			<ClerkOnly>
				<DeviceSessionsScreen />
			</ClerkOnly>
		</>
	);
}
