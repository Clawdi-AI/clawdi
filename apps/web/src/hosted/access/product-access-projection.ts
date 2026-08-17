import type { ProductAccess } from "@/lib/product-access";

function sameProductAccess(left: ProductAccess, right: ProductAccess): boolean {
	return (
		left.canUseLegacyHostedDashboard === right.canUseLegacyHostedDashboard &&
		left.legacyHostedAccessStatus === right.legacyHostedAccessStatus &&
		left.legacyDashboardUrl === right.legacyDashboardUrl &&
		left.canCreateCloudAgents === right.canCreateCloudAgents &&
		left.canUseCloudAgents === right.canUseCloudAgents &&
		left.canUseAgentPluginsUI === right.canUseAgentPluginsUI &&
		left.status === right.status &&
		left.isLoading === right.isLoading &&
		left.isError === right.isError &&
		left.isAllowed === right.isAllowed &&
		left.isDenied === right.isDenied &&
		left.isFetching === right.isFetching &&
		left.error === right.error &&
		left.refetch === right.refetch &&
		left.recheckCanCreateCloudAgents === right.recheckCanCreateCloudAgents
	);
}

export function publishProductAccessProjection(
	lastPublished: { current: ProductAccess | null },
	next: ProductAccess,
	onChange: (access: ProductAccess) => void,
): void {
	if (lastPublished.current && sameProductAccess(lastPublished.current, next)) return;
	lastPublished.current = next;
	onChange(next);
}
