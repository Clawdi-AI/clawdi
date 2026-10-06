import { useLocalSearchParams } from "expo-router";
import { SubscriptionDetailScreen } from "@/hosted/billing";

export default function SubscriptionRoute() {
	const { subscriptionId } = useLocalSearchParams<{ subscriptionId?: string | string[] }>();
	return (
		<SubscriptionDetailScreen
			subscriptionId={typeof subscriptionId === "string" ? subscriptionId : undefined}
		/>
	);
}
