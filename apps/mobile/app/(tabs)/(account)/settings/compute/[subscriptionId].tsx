import { Redirect } from "expo-router";

/** Subscription actions live on the Compute list, like Web; older links land there. */
export default function SubscriptionRedirect() {
	return <Redirect href="/settings/compute" />;
}
