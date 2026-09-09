import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";
import { unwrap, useApi } from "@/lib/api";
import { useRouteAuth } from "@/lib/auth-client";
import { clearDeployChannelUrl, deployChannelIntent } from "@/lib/deploy-channel";
import { env } from "@/lib/env";

const queryKey = ["settings", "deploy-channel"];
const BundleContext = createContext({
	data: false,
	isPending: true,
	isError: false,
	refetch: () => {},
});
export const useChannelBundle = () => useContext(BundleContext);

export function ChannelBundleBoundary({ children }: { children: ReactNode }) {
	const auth = useRouteAuth();
	if (!env.VITE_CLAWDI_HOSTED || auth.status !== "signed-in") return children;
	return (
		<ChannelBundleProvider key={auth.userId} userId={auth.userId}>
			{children}
		</ChannelBundleProvider>
	);
}

function ChannelBundleProvider({ userId, children }: { userId: string; children: ReactNode }) {
	const api = useApi();
	const router = useRouter();
	const queryClient = useQueryClient();
	const snapshot = useSyncExternalStore(
		deployChannelIntent.subscribe,
		deployChannelIntent.getSnapshot,
		deployChannelIntent.getServerSnapshot,
	);
	const intent = snapshot.intent?.userId === userId ? snapshot.intent : null;
	const settings = useQuery({
		queryKey,
		queryFn: async ({ signal }) =>
			unwrap(await api.GET("/v1/settings", { signal })).deploy_channel === "sui",
		staleTime: Infinity,
	});
	const { mutateAsync } = useMutation({
		onMutate: () => queryClient.cancelQueries({ queryKey }),
		mutationFn: async (signal: AbortSignal) => {
			unwrap(
				await api.PATCH("/v1/settings", { signal, body: { settings: { deploy_channel: "sui" } } }),
			);
		},
		onSuccess: async () => {
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData(queryKey, true);
			// The old account's request may finish after a switch. Only clean its own URL.
			if (deployChannelIntent.getSnapshot().intent?.userId === userId) {
				router.history.replace(clearDeployChannelUrl(router.history.location.href));
			}
		},
	});
	useEffect(() => {
		if (intent) void deployChannelIntent.claim(userId, mutateAsync);
	}, [intent, userId, mutateAsync]);
	return (
		<BundleContext.Provider
			value={{
				data: settings.data === true,
				isPending: settings.isPending || Boolean(intent && !snapshot.error),
				isError: settings.isError || Boolean(intent && snapshot.error),
				refetch: () => {
					if (intent && snapshot.error) void deployChannelIntent.claim(userId, mutateAsync);
					else void settings.refetch();
				},
			}}
		>
			{children}
		</BundleContext.Provider>
	);
}
