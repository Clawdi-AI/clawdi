import { settingsDialogClasses as styles } from "@clawdi/shared/ui";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { AppSafeAreaView, AppScrollView } from "@/components/ui/view";
import { WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { NativeSegments } from "@/platform/navigation/segmented-control";

export function SettingsShell({
	children,
	active = "general",
	scroll = true,
}: {
	children: ReactNode;
	active?: "general" | "api-keys" | "wallet" | "compute";
	scroll?: boolean;
}) {
	const t = useI18n();
	const router = useRouter();
	const { compute } = useMobileApi();
	const items = [
		{
			id: "general",
			label: t("settingsParity.general"),
			href: "/settings",
		},
		{ id: "api-keys", label: t("settingsParity.apiKeys"), href: "/settings/api-keys" },
		...(compute
			? [
					{
						id: "wallet",
						label: t("billingParity.wallet"),
						href: "/settings/wallet" as const,
					},
					{
						id: "compute",
						label: t("billingParity.compute"),
						href: "/settings/compute" as const,
					},
				]
			: []),
	] as const;
	return (
		<AppSafeAreaView edges={["left", "right"]} className="flex-1 bg-popover">
			{/* Keep the container in Android's accessibility hierarchy for scoped selectors.
			    https://reactnative.dev/docs/accessibility#importantforaccessibility-android */}
			<WebView
				testID="settings-navigation"
				importantForAccessibility="yes"
				recipe={styles.navigation}
			>
				<NativeSegments
					value={active}
					options={items.map((item) => ({ value: item.id, label: item.label }))}
					onChange={(value) => {
						const item = items.find((item) => item.id === value);
						if (item && item.id !== active) router.push(item.href);
					}}
				/>
			</WebView>
			{scroll ? (
				<AppScrollView
					keyboardShouldPersistTaps="handled"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={webView(styles.panel)}
				>
					{children}
				</AppScrollView>
			) : (
				children
			)}
		</AppSafeAreaView>
	);
}
