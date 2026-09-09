import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { unwrap, useApi } from "@/lib/api";
import { useRouteAuth } from "@/lib/auth-client";
import { claimDeployChannel, completeDeployChannelClaim } from "@/lib/deploy-channel";
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
	const href = useRouterState({ select: (state) => state.location.href });
	const queryClient = useQueryClient();
	const [claimed, setClaimed] = useState<boolean | null>(null);
	const started = useRef(false);
	const settings = useQuery({
		queryKey,
		queryFn: async () => unwrap(await api.GET("/v1/settings")).deploy_channel === "sui",
		staleTime: Infinity,
	});
	const save = useMutation({
		mutationFn: async () => {
			unwrap(await api.PATCH("/v1/settings", { body: { settings: { deploy_channel: "sui" } } }));
		},
		onSuccess: () => {
			completeDeployChannelClaim(userId);
			queryClient.setQueryData(queryKey, true);
			setClaimed(false);
		},
	});
	const { mutate } = save;
	useEffect(() => {
		started.current = false;
		setClaimed(claimDeployChannel(userId));
	}, [userId, href]);
	useEffect(() => {
		if (!claimed || settings.isPending || settings.isError || started.current) return;
		started.current = true;
		if (settings.data) {
			completeDeployChannelClaim(userId);
			setClaimed(false);
		} else mutate();
	}, [claimed, settings.isPending, settings.isError, settings.data, userId, mutate]);
	return (
		<BundleContext.Provider
			value={{
				data: settings.data === true,
				isPending: claimed === null || settings.isPending || (claimed && !save.isError),
				isError: settings.isError || save.isError,
				refetch: () => {
					if (save.isError) mutate();
					else void settings.refetch();
				},
			}}
		>
			{children}
		</BundleContext.Provider>
	);
}
