import { useLocalSearchParams } from "expo-router";
import { SubscriptionDetailScreen } from "@/hosted/billing/subscription/subscriptions-section";
import { routeParam } from "@/lib/route-params";
export default function SubscriptionPage() {
	const params = useLocalSearchParams<{ subscriptionId?: string | string[] }>();
	return <SubscriptionDetailScreen subscriptionId={routeParam(params.subscriptionId)} />;
}
