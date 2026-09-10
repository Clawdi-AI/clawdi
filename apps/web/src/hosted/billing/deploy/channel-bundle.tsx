import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { unwrap, useApi } from "@/lib/api";
import { useRouteAuth } from "@/lib/auth-client";
import { clearDeployChannelUrl, resolveDeployChannel } from "@/lib/deploy-channel";
import { env } from "@/lib/env";
import { routeAuthIdentity } from "@/lib/route-auth";

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
	return <ChannelBundleProvider key={routeAuthIdentity(auth)}>{children}</ChannelBundleProvider>;
}

function ChannelBundleProvider({ children }: { children: ReactNode }) {
	const api = useApi();
	const router = useRouter();
	const search = useRouterState({ select: (state) => state.location.searchStr });
	const queryClient = useQueryClient();
	const [attempt, setAttempt] = useState(0);
	const channel = attempt > 0;
	useLayoutEffect(() => {
		if (!resolveDeployChannel(search)) return;
		setAttempt((value) => value + 1);
		// Consume at admission so a failed or pending save cannot transfer to another account.
		router.history.replace(clearDeployChannelUrl(router.history.location.href));
	}, [search, router]);
	const settings = useQuery({
		queryKey,
		queryFn: async ({ signal }) =>
			unwrap(await api.GET("/v1/settings", { signal })).deploy_channel === "sui",
		enabled: !channel,
		staleTime: Infinity,
	});
	const { mutate, isPending, isError, isSuccess } = useMutation({
		onMutate: () => queryClient.cancelQueries({ queryKey }),
		mutationFn: async (signal: AbortSignal) => {
			signal.throwIfAborted();
			unwrap(
				await api.PATCH("/v1/settings", { signal, body: { settings: { deploy_channel: "sui" } } }),
			);
		},
		onSuccess: (_, signal) => {
			if (!signal.aborted) queryClient.setQueryData(queryKey, true);
		},
	});
	useEffect(() => {
		if (!attempt) return;
		const controller = new AbortController();
		mutate(controller.signal);
		return () => controller.abort();
	}, [attempt, mutate]);
	return (
		<BundleContext.Provider
			value={{
				data: settings.data === true,
				isPending: channel ? isPending || (!isError && !isSuccess) : settings.isPending,
				isError: channel ? isError : settings.isError,
				refetch: () => {
					if (channel && isError) setAttempt((value) => value + 1);
					else void settings.refetch();
				},
			}}
		>
			{children}
		</BundleContext.Provider>
	);
}
