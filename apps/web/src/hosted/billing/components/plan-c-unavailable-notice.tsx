import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function PlanCBillingUnavailableNotice({
	description = "New deployments, subscriptions, and plan changes are temporarily unavailable. Existing agents, subscriptions, payment recovery, and billing history remain available.",
}: {
	description?: string;
}) {
	return (
		<Alert data-hosted="true" data-testid="plan-c-unavailable">
			<Info aria-hidden />
			<AlertTitle>Subscription controls are temporarily unavailable</AlertTitle>
			<AlertDescription>{description}</AlertDescription>
		</Alert>
	);
}
