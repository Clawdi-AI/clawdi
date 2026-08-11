import { useCallback, useEffect, useState } from "react";
import { openSecureRuntimeWindow } from "@/hosted/agents/runtime-ui-credentials";
import { useAuthToken } from "@/lib/auth-client";
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
 * Open the Files origin in a new tab. The blank tab is opened synchronously so
 * the browser does not block it, the grant is primed, then the tab navigates —
 * the token still only travels in the `Authorization` header.
 */
export function useOpenFilesInNewTab(url: string): () => Promise<void> {
	const { getToken } = useAuthToken();
	return useCallback(async () => {
		const tab = openSecureRuntimeWindow(window.open.bind(window));
		if (!tab) {
			toastError("Couldn't open Files", {
				id: "files-new-tab",
				description: "Allow pop-ups for Clawdi, then try again.",
			});
			return;
		}
		try {
			const token = await getToken();
			if (!token) throw new Error("No Clerk session token");
			await primeFilesGrant(url, token);
			tab.location.replace(url);
		} catch {
			try {
				tab.close();
			} catch {
				// Browser isolation may have severed the WindowProxy.
			}
			toastError("Couldn't open Files", {
				id: "files-new-tab",
				description: "Files access couldn't be authenticated. Refresh the page and try again.",
			});
		}
	}, [url, getToken]);
}
