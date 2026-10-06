import { useLocalSearchParams } from "expo-router";
import { SubscriptionDetailScreen } from "@/hosted/billing/subscription/subscription-page";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { NativeHeader } from "@/platform/navigation/native-header";
export default function SubscriptionPage() {
	const t = useI18n();
	const params = useLocalSearchParams<{ subscriptionId?: string | string[] }>();
	return (
		<>
			<NativeHeader title={t("billing.details")} />
			<SubscriptionDetailScreen subscriptionId={routeParam(params.subscriptionId)} />
		</>
	);
}
