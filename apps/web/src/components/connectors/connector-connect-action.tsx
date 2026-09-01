"use client";

import { Check, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AccountAliasField } from "@/components/connectors/account-alias-field";
import { getConnectorAuthFlow } from "@/components/connectors/auth-flow.logic";
import { ConnectorCredentialsDialog } from "@/components/connectors/credentials-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
	const [oauthOpen, setOauthOpen] = useState(false);
	const [alias, setAlias] = useState("");
	const [connectError, setConnectError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const inflightRef = useRef(false);
	const authFlow = getConnectorAuthFlow(app.auth_type);
	const connect = useSensitiveAction(async (redirectUrl: string, accountAlias: string) =>
		unwrap(
			await api.POST("/v1/connectors/{app_name}/connect", {
				params: { path: { app_name: app.name } },
				body: { redirect_url: redirectUrl, ...(accountAlias ? { alias: accountAlias } : {}) },
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
		const desktop = typeof window !== "undefined" && Boolean(window.clawdiDesktop);
		const popup =
			typeof window !== "undefined" && !desktop ? window.open("about:blank", "_blank") : null;
		if (desktop) {
			inflightRef.current = true;
			const redirectUrl = new URL(redirectHref ?? window.location.href, window.location.origin)
				.href;
			void connect
				.execute(redirectUrl, alias.trim())
				.then((result) => window.open(result.connect_url, "_blank", "noopener"))
				.catch(() => {
					toast.error("Couldn't start connection", {
						description: "Try again. If the problem persists, contact support.",
					});
				})
				.finally(() => {
					inflightRef.current = false;
				});
			return;
		}
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
		setConnectError(null);
		const redirectUrl = new URL(redirectHref ?? window.location.href, window.location.origin).href;
		void connect
			.execute(redirectUrl, alias.trim())
			.then((result) => {
				if (!mountedRef.current) {
					popup.close();
					return;
				}
				if (popup.closed) {
					setConnectError("The authorization window was closed. Try connecting again.");
					return;
				}
				popup.location.href = result.connect_url;
				setOauthOpen(false);
			})
			.catch(() => {
				popup.close();
				if (mountedRef.current)
					setConnectError(
						"Couldn't start connection. Try again. If the problem persists, contact support.",
					);
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
				onClick={() => {
					if (authFlow === "credentials") setCredentialsOpen(true);
					else {
						setAlias("");
						setConnectError(null);
						setOauthOpen(true);
					}
				}}
				disabled={connect.isPending}
			>
				{connect.isPending ? <Spinner className="size-3.5" /> : <Plug className="size-3.5" />}
				{connect.isPending ? "Connecting…" : label}
			</Button>
			<Dialog
				open={oauthOpen}
				onOpenChange={(open) => {
					if (!inflightRef.current) setOauthOpen(open);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Connect {app.display_name}</DialogTitle>
						<DialogDescription>
							Add an optional name, then authorize your account in a new window.
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							startConnect();
						}}
						className="flex flex-col gap-4"
					>
						<AccountAliasField value={alias} onChange={setAlias} disabled={connect.isPending} />
						{connectError ? (
							<p role="alert" className="text-sm text-destructive">
								{connectError}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={connect.isPending}
								onClick={() => setOauthOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={connect.isPending}>
								{connect.isPending ? <Spinner className="size-3.5" /> : null}
								Continue
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<ConnectorCredentialsDialog
				key={app.name}
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
				appName={app.name}
				displayName={app.display_name}
			/>
		</>
	);
}
