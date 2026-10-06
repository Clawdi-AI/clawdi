import { settingsDialogClasses as styles } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { CreditCard, Key, SlidersHorizontal, WalletCards } from "lucide-react-native";
import type { ReactNode } from "react";
import { AppSafeAreaView, AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { NativeSegments } from "@/platform/navigation/segmented-control";

export function SettingsShell({
	children,
	active = "general",
	back: _back,
}: {
	children: ReactNode;
	active?: "general" | "api-keys" | "wallet" | "compute";
	back?: boolean;
}) {
	const t = useI18n();
	const router = useRouter();
	const { compute } = useMobileApi();
	const items = [
		{
			id: "general",
			label: t("settingsParity.general"),
			icon: SlidersHorizontal,
			href: "/settings",
		},
		{ id: "api-keys", label: t("settingsParity.apiKeys"), icon: Key, href: "/settings/api-keys" },
		...(compute
			? [
					{
						id: "wallet",
						label: t("billingParity.wallet"),
						icon: WalletCards,
						href: "/settings/wallet" as const,
					},
					{
						id: "compute",
						label: t("billingParity.compute"),
						icon: CreditCard,
						href: "/settings/compute" as const,
					},
				]
			: []),
	] as const;
	return (
		<AppSafeAreaView edges={["left", "right"]} className="flex-1 bg-popover">
			<WebView recipe={styles.navigation}>
				<NativeSegments
					value={active}
					options={items.map((item) => ({ value: item.id, label: item.label }))}
					onChange={(value) => {
						const item = items.find((item) => item.id === value);
						if (item && item.id !== active) router.push(item.href);
					}}
				/>
			</WebView>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName={webView(styles.panel)}
			>
				{children}
			</AppScrollView>
		</AppSafeAreaView>
	);
}
