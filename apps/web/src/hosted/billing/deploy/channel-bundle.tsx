import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import { unwrap, useApi } from "@/lib/api";
import { useRouteAuth } from "@/lib/auth-client";
import { clearDeployChannelUrl, resolveDeployChannel } from "@/lib/deploy-channel";
import { env } from "@/lib/env";
import { routeAuthIdentity } from "@/lib/route-auth";

const queryKey = ["settings", "deploy-channel"];
const ownerKey = "clawdi:deploy-channel-owner";
const BundleContext = createContext({
	data: false,
	isPending: true,
	isError: false,
	storageError: false,
	refetch: () => {},
});
export const useChannelBundle = () => useContext(BundleContext);

export function ChannelBundleBoundary({ children }: { children: ReactNode }) {
	const auth = useRouteAuth();
	if (!env.VITE_CLAWDI_HOSTED || auth.status !== "signed-in") return children;
	return (
		<ChannelBundleProvider key={routeAuthIdentity(auth)} userId={auth.userId}>
			{children}
		</ChannelBundleProvider>
	);
}

function ChannelBundleProvider({ children, userId }: { children: ReactNode; userId: string }) {
	const api = useApi();
	const router = useRouter();
	const search = useRouterState({ select: (state) => state.location.searchStr });
	const queryClient = useQueryClient();
	const [attempt, setAttempt] = useState(0);
	const [storageError, setStorageError] = useState(false);
	const channel = attempt > 0;
	const admit = useCallback(() => {
		try {
			// Bind before any async work. Keep the owner across reloads until the save succeeds.
			const owner = sessionStorage.getItem(ownerKey);
			if (owner !== null && owner !== userId) return;
			sessionStorage.setItem(ownerKey, userId);
			setStorageError(false);
			setAttempt((value) => value + 1);
		} catch {
			// Without a durable tab owner, leave the URL intact and fail closed.
			setStorageError(true);
		}
	}, [userId]);
	useLayoutEffect(() => {
		if (!resolveDeployChannel(search)) return;
		admit();
	}, [search, admit]);
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
			if (signal.aborted) return;
			queryClient.setQueryData(queryKey, true);
			router.history.replace(clearDeployChannelUrl(router.history.location.href));
			try {
				sessionStorage.removeItem(ownerKey);
			} catch {
				// Persistence already succeeded; a retained owner only blocks another account.
			}
		},
	});
	useLayoutEffect(() => {
		if (!attempt) return;
		const controller = new AbortController();
		mutate(controller.signal);
		return () => controller.abort();
	}, [attempt, mutate]);
	return (
		<BundleContext.Provider
			value={{
				data: settings.data === true,
				isPending:
					!storageError && (channel ? isPending || (!isError && !isSuccess) : settings.isPending),
				isError: storageError || (channel ? isError : settings.isError),
				storageError,
				refetch: () => {
					if (storageError || (channel && isError)) admit();
					else void settings.refetch();
				},
			}}
		>
			{children}
		</BundleContext.Provider>
	);
}
