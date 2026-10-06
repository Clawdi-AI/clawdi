import { settingsDialogClasses as styles } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import { ArrowLeft, CreditCard, Key, SlidersHorizontal, WalletCards } from "lucide-react-native";
import type { ReactNode } from "react";
import { useMobileApi } from "@/components/api-provider";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppSafeAreaView, AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";

export function SettingsShell({
	children,
	active = "general",
	back = false,
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
			href: "/(tabs)/account",
		},
		{ id: "api-keys", label: t("settingsParity.apiKeys"), icon: Key, href: "/api-keys" },
		...(compute
			? [
					{
						id: "wallet",
						label: t("billingParity.wallet"),
						icon: WalletCards,
						href: "/billing/wallet" as const,
					},
					{
						id: "compute",
						label: t("billingParity.compute"),
						icon: CreditCard,
						href: "/billing" as const,
					},
				]
			: []),
	] as const;
	return (
		<AppSafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-popover">
			<WebView recipe={styles.header} className={back ? "justify-start" : undefined}>
				{back ? (
					<Button
						variant="ghost"
						size="icon-sm"
						accessibilityLabel={t("navigation.back")}
						onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/account"))}
					>
						<Icon as={ArrowLeft} />
					</Button>
				) : null}
				<WebText recipe={styles.title}>{t("account.settings")}</WebText>
			</WebView>
			<WebView recipe={styles.navigation}>
				<AppScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerClassName={`${webView(styles.navigationItems)} flex-row`}
				>
					{items.map((item) => (
						<Button
							key={item.id}
							variant="ghost"
							className={webBoth(`${styles.navigationButton} ${styles.navigationActive}`, {
								"data-[active=true]": item.id === active,
							})}
							onPress={() => {
								if (item.id !== active) router.push(item.href);
							}}
						>
							<IconChip
								size="sm"
								tint={
									item.id === active
										? "bg-primary text-primary-foreground"
										: "bg-background text-foreground"
								}
							>
								<Icon as={item.icon} />
							</IconChip>
							<Text className={webBoth(styles.navigationLabel)}>{item.label}</Text>
						</Button>
					))}
				</AppScrollView>
			</WebView>
			<AppScrollView
				keyboardShouldPersistTaps="handled"
				contentContainerClassName={webView(styles.panel)}
			>
				{children}
			</AppScrollView>
		</AppSafeAreaView>
	);
}
