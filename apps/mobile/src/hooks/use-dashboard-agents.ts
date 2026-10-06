import {
	claimedEnvIdsFromDeployments,
	deploymentToTiles,
	selectUnifiedAgentList,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { useCloudAgents } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
/** Both inventories are account-fenced. Unresolved membership never claims an empty account. */
export function useDashboardAgents() {
	const agents = useCloudAgents();
	const { hosted, compute } = useMobileApi(),
		scope = useAccountScope(),
		read = useAccountRead();
	const inventory = useQuery({
		queryKey: accountQueryKey(scope, "deployments"),
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!hosted) throw new Error("Hosted API unavailable");
				return hosted.listDeployments(lease);
			}, signal),
		enabled: scope.isReady && Boolean(hosted),
		retry: false,
	});
	const capabilities = useQuery({
		queryKey: accountQueryKey(scope, "product-capabilities"),
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getProductCapabilities(lease);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const envs = agents.data ?? [],
		envById = new Map(envs.map((env) => [env.id.toLowerCase(), env]));
	const deployments = inventory.data ?? [],
		claimed = claimedEnvIdsFromDeployments(deployments);
	// Mobile is v2-only: legacy (v1 hosted) environment ids are read solely to keep
	// those agents out of the list, never to render legacy tiles.
	const legacy = useQuery({
		queryKey: accountQueryKey(scope, "legacy-agent-ids"),
		enabled: scope.isReady && Boolean(compute) && Boolean(capabilities.data?.can_use_v1),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getLegacyAgentIds(lease);
			}, signal),
	});
	const legacyResolved =
		!compute || capabilities.data?.can_use_v1 === false || legacy.data !== undefined;
	const error = inventory.error ?? capabilities.error ?? legacy.error;
	const cloud = deployments.flatMap((d) => deploymentToTiles(d, envById));
	const selection = selectUnifiedAgentList({
		cloudEnvs: envs,
		hostedTiles: cloud,
		claimedEnvIds: claimed,
		legacyEnvIds: legacyResolved
			? new Set((legacy.data ?? []).map((id) => id.toLowerCase()))
			: null,
		hostedInventoryStatus:
			!hosted || inventory.data !== undefined
				? "resolved"
				: inventory.isError
					? "error"
					: "loading",
		showLegacyAgents: false,
	});
	return {
		agents,
		inventory,
		capabilities,
		hasHosted: Boolean(hosted),
		tiles: selection.tiles,
		canDeploy: capabilities.data?.can_use_v2 ?? false,
		hostedStatus: hosted
			? {
					isLoading:
						inventory.isPending ||
						capabilities.isPending ||
						(capabilities.data?.can_use_v1 && legacy.isPending) === true,
					error: error ?? undefined,
					onRetry: () => {
						void inventory.refetch();
						void capabilities.refetch();
						if (capabilities.data?.can_use_v1) void legacy.refetch();
					},
				}
			: undefined,
	};
}
