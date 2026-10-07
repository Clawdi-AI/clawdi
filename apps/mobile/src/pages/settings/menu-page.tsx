import { type Href, useRouter } from "expo-router";
import { CreditCard, Key, SlidersHorizontal, UserCog, WalletCards } from "lucide-react-native";
import {
	SettingsMenu,
	type SettingsMenuRow,
	type SettingsMenuSection,
} from "@/components/settings/settings-menu";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useCurrentUser } from "@/platform/auth/auth-client";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

/** Account tab root: Web's settings dialog sidebar as a native settings list. */
export default function SettingsMenuPage() {
	const t = useI18n();
	const router = useRouter();
	const { compute } = useMobileApi();
	const { user } = useCurrentUser();
	const row = (
		id: string,
		href: Href,
		icon: SettingsMenuRow["icon"],
		label: string,
		description?: string,
	): SettingsMenuRow => ({ id, icon, label, description, onPress: () => router.push(href) });
	const sections: SettingsMenuSection[] = [
		{
			id: "account",
			rows: [
				row(
					"account",
					"/settings/account",
					UserCog,
					t("settingsParity.manageAccount"),
					user?.primaryEmailAddress?.emailAddress,
				),
			],
		},
		{
			id: "panels",
			rows: [
				row(
					"general",
					"/settings/general",
					SlidersHorizontal,
					t("settingsParity.general"),
					t("settingsParity.generalSummary"),
				),
				row(
					"api-keys",
					"/settings/api-keys",
					Key,
					t("settingsParity.apiKeys"),
					t("settingsParity.apiKeysSummary"),
				),
				...(compute
					? [
							row(
								"wallet",
								"/settings/wallet",
								WalletCards,
								t("billingParity.wallet"),
								t("billingParity.walletSummary"),
							),
							row(
								"compute",
								"/settings/compute",
								CreditCard,
								t("billingParity.compute"),
								t("billingParity.computeSummary"),
							),
						]
					: []),
			],
		},
	];
	return (
		<SafeAreaScreen>
			<NativeHeader title={t("settingsParity.title")} />
			<SettingsMenu sections={sections} />
		</SafeAreaScreen>
	);
}
