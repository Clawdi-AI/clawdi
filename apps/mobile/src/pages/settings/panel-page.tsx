import { useLocalSearchParams } from "expo-router";
import { EmptyState } from "@/components/empty-state";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { SettingsShell } from "@/components/settings/shell";
import { BillingScreen } from "@/hosted/billing/subscription/subscriptions-section";
import { WalletScreen } from "@/hosted/billing/wallet/wallet-page";
import GeneralPage from "@/pages/settings/general-page";

export default function SettingsPanelPage() {
	const { panel } = useLocalSearchParams<{ panel?: string }>();
	switch (panel) {
		case "general":
			return <GeneralPage />;
		case "api-keys":
			return (
				<SettingsShell scroll={false}>
					<ApiKeysPanel />
				</SettingsShell>
			);
		case "wallet":
			return <WalletScreen />;
		case "compute":
		case "billing":
			return <BillingScreen />;
		default:
			return (
				<SettingsShell>
					<EmptyState title="Settings unavailable" />
				</SettingsShell>
			);
	}
}
