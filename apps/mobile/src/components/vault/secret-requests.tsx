import { type components, vaultRequestsRefetchInterval } from "@clawdi/shared/api";
import { VAULT_SECRET_REQUESTS_COPY as copy, vaultSecretRequestMeta } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

/** Web's read-only "Recent secret requests" list on an owned vault. */
export function VaultSecretRequests({
	current,
}: {
	current: components["schemas"]["VaultResponse"];
}) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	const cache = useQueryClient();
	const focused = useIsFocused();
	const requests = useQuery({
		queryKey: accountQueryKey(scope, "vault-requests", current.id, current.slug),
		queryFn: async ({ signal }) => {
			const rows = await read((s) => vault.listRequests(current, s), signal);
			if (rows.some((row) => row.status === "supplied"))
				void cache.invalidateQueries({
					queryKey: accountQueryKey(scope, "vault-sections", current.id),
				});
			return rows;
		},
		enabled: scope.isReady && current.is_owner && focused,
		retry: false,
		refetchInterval: (query) => (focused ? vaultRequestsRefetchInterval(query.state.data) : false),
	});
	if (requests.isError)
		return (
			<WebView recipe="flex-row flex-wrap items-center gap-1" accessibilityRole="alert">
				<WebText recipe="text-sm">{copy.loadFailed}</WebText>
				<Button variant="link" onPress={() => void requests.refetch()}>
					<Text>{copy.retry}</Text>
				</Button>
			</WebView>
		);
	if (!requests.data?.length) return null;
	return (
		<WebView recipe="space-y-3 rounded-xl border p-4" accessibilityLabel={copy.label}>
			<WebText recipe="font-medium" accessibilityRole="header">
				{copy.title}
			</WebText>
			{requests.data.map((row) => (
				<WebView
					key={row.id}
					recipe="flex flex-wrap items-start justify-between gap-2 text-sm"
					className="flex-row"
				>
					<WebView recipe="min-w-0 flex-1">
						<WebText recipe="font-mono text-sm">{row.fields.join(", ")}</WebText>
						<WebText recipe="text-xs text-muted-foreground">{vaultSecretRequestMeta(row)}</WebText>
					</WebView>
					<Badge variant="secondary">
						<Text>{copy.status[row.status]}</Text>
					</Badge>
				</WebView>
			))}
		</WebView>
	);
}
