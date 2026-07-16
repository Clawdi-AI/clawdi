import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function PlanCBillingUnavailableNotice({
	description = "You can still review existing agents and billing history. New deploys, subscription changes, and payment recovery will return when this billing rollout is enabled for your account.",
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
