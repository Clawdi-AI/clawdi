import { CLAWDI_HELP_MENU, CLAWDI_LEGAL_URLS } from "@clawdi/shared/view";
import { type Href, useRouter } from "expo-router";
import BookOpen from "lucide-react-native/icons/book-open";
import BarChart3 from "lucide-react-native/icons/chart-column";
import CreditCard from "lucide-react-native/icons/credit-card";
import FileText from "lucide-react-native/icons/file-text";
import Key from "lucide-react-native/icons/key";
import Mail from "lucide-react-native/icons/mail";
import MessageCircle from "lucide-react-native/icons/message-circle";
import MessagesSquare from "lucide-react-native/icons/messages-square";
import Shield from "lucide-react-native/icons/shield";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import WalletCards from "lucide-react-native/icons/wallet-cards";
import { Alert, Linking } from "react-native";
import { GitHubIcon } from "@/components/github-icon";
import {
	SettingsMenu,
	type SettingsMenuRow,
	type SettingsMenuSection,
} from "@/components/settings/settings-menu";
import { useSupportChat } from "@/hooks/use-support-chat";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { openBrowserLink } from "@/platform/native-intent";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useStoreSurfaces } from "@/platform/store/store-provider";

const HELP_ICONS = {
	docs: BookOpen,
	github: GitHubIcon,
	email: Mail,
	telegram: MessageCircle,
} as const;

/** Settings tab root: Web's settings dialog sidebar as a native settings list. */
export default function SettingsMenuPage() {
	const t = useI18n();
	const router = useRouter();
	const { compute } = useMobileApi();
	const openSupportChat = useSupportChat();
	const surfaces = useStoreSurfaces();
	const row = (
		id: string,
		href: Href,
		icon: SettingsMenuRow["icon"],
		label: string,
		description?: string,
	): SettingsMenuRow => ({ id, icon, label, description, onPress: () => router.push(href) });
	// Web's Help menu, then the legal pages App Review expects to be reachable in-app.
	const link = (
		id: string,
		url: string,
		icon: SettingsMenuRow["icon"],
		label: string,
	): SettingsMenuRow => ({
		id,
		icon,
		label,
		onPress: () => {
			const mail = url.startsWith("mailto:");
			(mail ? Linking.openURL(url) : openBrowserLink(url)).catch(() =>
				Alert.alert(t(mail ? "runtime.supportFailed" : "settingsMenu.linkFailed")),
			);
		},
	});
	const sections: SettingsMenuSection[] = [
		{
			id: "settings",
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
			],
		},
		...(compute
			? [
					{
						id: "hosted",
						rows: [
							row(
								"wallet",
								"/settings/wallet",
								WalletCards,
								t("billingParity.wallet"),
								t(surfaces.cardBilling ? "billingParity.walletSummary" : "store.walletSummary"),
							),
							row(
								"compute",
								"/settings/compute",
								CreditCard,
								t("billingParity.compute"),
								t("billingParity.computeSummary"),
							),
							row(
								"usage",
								"/settings/usage",
								BarChart3,
								t("usageParity.nav"),
								t("usageParity.navSummary"),
							),
						],
					},
				]
			: []),
		{
			id: "help",
			rows: [
				...CLAWDI_HELP_MENU.flatMap((item): SettingsMenuRow[] => {
					if (item.id !== "live-chat")
						return [link(item.id, item.href, HELP_ICONS[item.id], item.label)];
					return openSupportChat
						? [
								{
									id: item.id,
									icon: MessagesSquare,
									label: item.label,
									onPress: () => openSupportChat(),
								},
							]
						: [];
				}),
				link("privacy", CLAWDI_LEGAL_URLS.privacyPolicy, Shield, t("settingsMenu.privacyPolicy")),
				link("terms", CLAWDI_LEGAL_URLS.termsOfUse, FileText, t("settingsMenu.termsOfUse")),
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
