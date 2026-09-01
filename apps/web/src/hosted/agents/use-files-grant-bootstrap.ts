import { useCallback, useEffect, useState } from "react";
import { openSecureRuntimeWindow } from "@/hosted/agents/runtime-ui-credentials";
import { trackRuntimeWindow } from "@/hosted/agents/runtime-window-lifecycle";
import { useAuthToken } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { toastError } from "@/lib/toast";

export type FilesGrantBootstrapState = "pending" | "ready" | "error";

/**
 * The Files origin is a distinct subdomain that never receives the Clerk
 * `__session` cookie. We prime a deployment-scoped `__Host-clawdi_files_grant`
 * HttpOnly cookie by sending the Clerk session token in the `Authorization`
 * header (never in the URL/iframe src/DOM) to the Files origin, then render the
 * iframe only after that grant is set. See the ForwardAuth bootstrap contract.
 */
async function primeFilesGrant(url: string, token: string): Promise<void> {
	const response = await fetch(url, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
		credentials: "include",
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`Files bootstrap rejected with status ${response.status}`);
	}
}

export function useFilesGrantBootstrap(url: string): FilesGrantBootstrapState {
	const { getToken } = useAuthToken();
	const [state, setState] = useState<FilesGrantBootstrapState>("pending");

	useEffect(() => {
		let cancelled = false;
		setState("pending");
		void (async () => {
			try {
				const token = await getToken();
				if (!token) throw new Error("No Clerk session token");
				await primeFilesGrant(url, token);
				if (!cancelled) setState("ready");
			} catch {
				if (!cancelled) setState("error");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, getToken]);

	return state;
}

/**
 * Open the Files origin in a new window. The blank window is opened synchronously
 * so the browser does not block it, the grant is primed, then it navigates. The
 * token still only travels in the `Authorization` header.
 */
export function useOpenFilesInNewWindow(url: string, deploymentId: string): () => Promise<void> {
	const { getToken } = useAuthToken();
	return useCallback(async () => {
		const popup = openSecureRuntimeWindow(window.open.bind(window));
		if (!popup) {
			toastError("Couldn't open Files", {
				id: "files-window-launch",
				description: env.VITE_CLAWDI_DESKTOP_BUILD
					? "Opening Files in a separate window is not supported in Clawdi Desktop yet. Use the browser Dashboard."
					: "Allow pop-ups for Clawdi, then try again.",
			});
			return;
		}
		trackRuntimeWindow(deploymentId, popup);
		try {
			const token = await getToken();
			if (!token) throw new Error("No Clerk session token");
			await primeFilesGrant(url, token);
			popup.location.replace(url);
		} catch {
			try {
				popup.close();
			} catch {
				// Browser isolation may have severed the WindowProxy.
			}
			toastError("Couldn't open Files", {
				id: "files-window-launch",
				description: "Files access couldn't be authenticated. Refresh the page and try again.",
			});
		}
	}, [deploymentId, url, getToken]);
}
