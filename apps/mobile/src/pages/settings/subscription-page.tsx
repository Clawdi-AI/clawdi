import { useLocalSearchParams } from "expo-router";
import { SubscriptionDetailScreen } from "@/hosted/billing/subscription/subscription-page";
import { routeParam } from "@/lib/route-params";
export default function SubscriptionPage() {
	const params = useLocalSearchParams<{ subscriptionId?: string | string[] }>();
	return <SubscriptionDetailScreen subscriptionId={routeParam(params.subscriptionId)} />;
}
