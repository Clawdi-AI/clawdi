import {
	CLAWDI_HELP_COPY,
	CLAWDI_HELP_URLS,
	CLAWDI_LEGAL_URLS,
	SUPPORT_EMAIL,
} from "@clawdi/shared/view";
import { type Href, useRouter } from "expo-router";
import {
	BarChart3,
	BookOpen,
	CreditCard,
	FileText,
	Key,
	Mail,
	MessageCircle,
	Shield,
	SlidersHorizontal,
	UserCog,
	WalletCards,
} from "lucide-react-native";
import { Alert, Linking } from "react-native";
import {
	SettingsMenu,
	type SettingsMenuRow,
	type SettingsMenuSection,
} from "@/components/settings/settings-menu";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useCurrentUser } from "@/platform/auth/auth-client";
import { openBrowserLink } from "@/platform/native-intent";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/** Account tab root: Web's settings dialog sidebar as a native settings list. */
export default function SettingsMenuPage() {
	const t = useI18n();
	const router = useRouter();
	const { compute } = useMobileApi();
	const { user } = useCurrentUser();
	const surfaces = useStoreSurfaces();
	const row = (
		id: string,
		href: Href,
		icon: SettingsMenuRow["icon"],
		label: string,
		description?: string,
	): SettingsMenuRow => ({ id, icon, label, description, onPress: () => router.push(href) });
	// Web's Help menu plus the legal pages App Review expects to be reachable in-app.
	const link = (
		id: string,
		url: string,
		icon: SettingsMenuRow["icon"],
		label: string,
		description?: string,
	): SettingsMenuRow => ({
		id,
		icon,
		label,
		description,
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
					t("settingsMenu.generalSummary"),
				),
				row(
					"account",
					"/settings/account",
					UserCog,
					t("settingsParity.account"),
					user?.primaryEmailAddress?.emailAddress ?? t("settingsParity.accountDescription"),
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
								t("billingParity.walletSummary"),
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
								t(surfaces.creditUnits ? "store.usageSummary" : "usageParity.navSummary"),
							),
						],
					},
				]
			: []),
		{
			id: "help",
			rows: [
				link("docs", CLAWDI_HELP_URLS.docs, BookOpen, CLAWDI_HELP_COPY.docs),
				link(
					"support",
					`mailto:${SUPPORT_EMAIL}`,
					Mail,
					CLAWDI_HELP_COPY.emailSupport,
					SUPPORT_EMAIL,
				),
				link("telegram", CLAWDI_HELP_URLS.telegram, MessageCircle, CLAWDI_HELP_COPY.telegram),
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
