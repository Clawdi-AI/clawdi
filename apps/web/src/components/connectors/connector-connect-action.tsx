"use client";

import { Check, Plug } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { getConnectorAuthFlow } from "@/components/connectors/auth-flow.logic";
import { ConnectorCredentialsDialog } from "@/components/connectors/credentials-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { ConnectorAvailableApp } from "@/lib/connectors-data";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/** Shared connect entry point for connector cards and details. */
export function ConnectorConnectAction({
	app,
	label = "Connect",
	emphasis = "secondary",
	redirectHref,
}: {
	app: ConnectorAvailableApp;
	label?: string;
	emphasis?: "primary" | "secondary";
	redirectHref?: string;
}) {
	const api = useApi();
	const [credentialsOpen, setCredentialsOpen] = useState(false);
	const inflightRef = useRef(false);
	const authFlow = getConnectorAuthFlow(app.auth_type);
	const connect = useSensitiveAction(async (redirectUrl: string) =>
		unwrap(
			await api.POST("/v1/connectors/{app_name}/connect", {
				params: { path: { app_name: app.name } },
				body: { redirect_url: redirectUrl },
			}),
		),
	);

	if (authFlow === "no_auth") {
		return (
			<Badge variant="secondary">
				<Check />
				Ready
			</Badge>
		);
	}
	if (app.connect_disabled || authFlow === null) {
		const unavailableReason = app.connect_disabled
			? app.connect_disabled_reason?.trim() || "Additional configuration is required."
			: "This authentication method is not supported.";
		return (
			<Badge
				variant="outline"
				title={unavailableReason}
				aria-label={`Unavailable: ${unavailableReason}`}
			>
				Unavailable
			</Badge>
		);
	}

	const startConnect = () => {
		if (inflightRef.current || connect.isPending) return;
		if (authFlow === "credentials") {
			setCredentialsOpen(true);
			return;
		}
		const popup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
		if (!popup) {
			toast.error("Popup blocked", { description: "Allow popups for this site to continue." });
			return;
		}
		try {
			popup.opener = null;
		} catch {
			// The blank same-origin window normally permits this; navigation remains safe if it does not.
		}
		inflightRef.current = true;
		const redirectUrl = new URL(redirectHref ?? window.location.href, window.location.origin).href;
		void connect
			.execute(redirectUrl)
			.then((result) => {
				if (!popup.closed) popup.location.href = result.connect_url;
			})
			.catch(() => {
				popup.close();
				toast.error("Couldn't start connection", {
					description: "Try again. If the problem persists, contact support.",
				});
			})
			.finally(() => {
				inflightRef.current = false;
			});
	};

	return (
		<>
			<Button
				variant={emphasis === "primary" ? "default" : "outline"}
				size="sm"
				onClick={startConnect}
				disabled={connect.isPending}
			>
				{connect.isPending ? <Spinner className="size-3.5" /> : <Plug className="size-3.5" />}
				{connect.isPending ? "Connecting…" : label}
			</Button>
			<ConnectorCredentialsDialog
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
				appName={app.name}
				displayName={app.display_name}
			/>
		</>
	);
}
