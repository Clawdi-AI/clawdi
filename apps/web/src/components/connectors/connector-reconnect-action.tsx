"use client";

import type { components } from "@clawdi/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConnectorCredentialsDialog } from "@/components/connectors/credentials-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import { isActiveConnection } from "@/lib/connectors-data";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

export function ConnectorReconnectAction({
	connection,
	displayName,
	disabled,
}: {
	connection: components["schemas"]["ConnectorConnectionResponse"];
	displayName: string;
	disabled: boolean;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [credentialsOpen, setCredentialsOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inflightRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const reconnect = useSensitiveAction(async () =>
		unwrap(
			await api.POST("/v1/connectors/{connection_id}/reconnect", {
				params: { path: { connection_id: connection.id } },
				body: { redirect_url: window.location.href },
			}),
		),
	);
	const strategy = connection.reconnect_strategy;
	if (isActiveConnection(connection)) return null;
	if (!strategy || strategy === "unsupported") {
		return <span className="text-xs text-muted-foreground">Reconnect unavailable</span>;
	}

	async function startReconnect() {
		if (disabled || inflightRef.current) return;
		if (strategy === "credentials") {
			setCredentialsOpen(true);
			return;
		}
		const popup = strategy === "oauth" ? window.open("about:blank", "_blank") : null;
		if (strategy === "oauth" && !popup) {
			setError("Popup blocked. Allow popups for this site, then try again.");
			return;
		}
		if (popup) {
			try {
				popup.opener = null;
			} catch {
				// Navigation can still proceed if the browser prevents clearing the opener.
			}
		}
		inflightRef.current = true;
		setError(null);
		try {
			const result = await reconnect.execute();
			if (!mountedRef.current) {
				popup?.close();
				return;
			}
			if (result.connect_url) {
				if (!popup || popup.closed) {
					setError("The authorization window was closed. Try reconnecting again.");
					return;
				}
				popup.location.href = result.connect_url;
			} else {
				popup?.close();
				if (result.status.toUpperCase() === "ACTIVE") toast.success("Account reconnected");
				else
					setError("The account is not active yet. Refresh its status or try reconnecting again.");
			}
			void queryClient.invalidateQueries({ queryKey: ["get", "/v1/connectors"] });
		} catch {
			popup?.close();
			if (mountedRef.current) setError("Couldn't reconnect this account. Try again.");
		} finally {
			inflightRef.current = false;
		}
	}

	return (
		<div className="flex flex-col items-start gap-1">
			<Button
				variant="outline"
				size="xs"
				disabled={disabled || reconnect.isPending}
				onClick={() => void startReconnect()}
			>
				{reconnect.isPending ? <Spinner className="size-3.5" /> : null}
				{strategy === "credentials"
					? "Update credentials"
					: strategy === "enable"
						? "Enable account"
						: "Reconnect"}
			</Button>
			{error ? (
				<p role="alert" className="max-w-xs text-xs text-destructive">
					{error}
				</p>
			) : null}
			<ConnectorCredentialsDialog
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
				appName={connection.app_name}
				displayName={displayName}
				connection={connection}
			/>
		</div>
	);
}
