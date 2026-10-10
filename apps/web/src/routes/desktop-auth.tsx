"use client";

import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { useAuth, useSignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { routeHeadTitle } from "@/lib/document-title";

export const Route = createFileRoute("/desktop-auth")({
	head: () => routeHeadTitle("Signing in"),
	component: DesktopAuthPage,
});

export function DesktopAuthPage() {
	const [desktopBridge, setDesktopBridge] = useState<ClawdiDesktopBridge | null>(null);
	const [loaded, setLoaded] = useState(false);
	useEffect(() => {
		const candidate = "clawdiDesktop" in window ? window.clawdiDesktop : undefined;
		setDesktopBridge(isDesktopBridge(candidate) ? candidate : null);
		setLoaded(true);
	}, []);
	if (!loaded) return null;
	if (!desktopBridge)
		return (
			<main className="flex min-h-dvh items-center justify-center bg-background p-6">
				<div className="flex max-w-sm flex-col items-center gap-4 text-center">
					<h1 className="text-lg font-semibold">Open this page in Clawdi Desktop</h1>
					<p className="text-sm text-muted-foreground">
						Desktop sign-in is available only inside the Clawdi app.
					</p>
					<Button onClick={() => window.location.replace("/")}>Open Dashboard</Button>
				</div>
			</main>
		);
	return <DesktopTicketSignIn desktopBridge={desktopBridge} />;
}

function DesktopTicketSignIn({ desktopBridge }: { desktopBridge: ClawdiDesktopBridge }) {
	const { isLoaded: authLoaded, isSignedIn, userId } = useAuth();
	const { signIn } = useSignIn();
	const attempted = useRef(false);
	const [failed, setFailed] = useState(false);
	const [recovering, setRecovering] = useState<"retry" | "sign-in" | null>(null);

	async function recover(action: "retry" | "sign-in") {
		setRecovering(action);
		try {
			if (action === "sign-in") desktopBridge.openConnector();
			else window.location.reload();
		} catch {
			setFailed(true);
		} finally {
			setRecovering(null);
		}
	}

	useEffect(() => {
		if (!authLoaded || attempted.current) return;
		attempted.current = true;

		window.history.replaceState(null, "", window.location.pathname);
		void restoreDesktopSession({
			bridge: desktopBridge,
			userId: isSignedIn ? userId : null,
			consumeTicket: async (ticket) => {
				const { error } = await signIn.ticket({ ticket });
				if (error || signIn.status !== "complete") throw new Error("Sign-in failed.");
				const finalized = await signIn.finalize();
				if (finalized.error) throw new Error("Sign-in finalization failed.");
			},
		})
			.then(() => window.location.replace("/"))
			.catch(() => setFailed(true));
	}, [authLoaded, desktopBridge, isSignedIn, signIn, userId]);

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				{failed ? (
					<>
						<h1 className="text-lg font-semibold">Desktop sign-in expired</h1>
						<div className="flex items-center gap-2">
							<Button
								disabled={recovering !== null}
								onClick={() => void recover("sign-in")}
								variant="outline"
							>
								Sign in again
							</Button>
							<Button disabled={recovering !== null} onClick={() => void recover("retry")}>
								{recovering === "retry" ? "Retrying…" : "Try again"}
							</Button>
						</div>
					</>
				) : (
					<>
						<LoaderCircle className="size-6 animate-spin text-muted-foreground" />
						<h1 className="text-lg font-semibold">Signing in to Clawdi</h1>
					</>
				)}
			</div>
		</main>
	);
}

/** Capability detection only; tickets in the URL never authorize this route. */
function isDesktopBridge(value: unknown): value is ClawdiDesktopBridge {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 1 &&
		"createDashboardSession" in value &&
		typeof value.createDashboardSession === "function" &&
		"openConnector" in value &&
		typeof value.openConnector === "function" &&
		"openInBrowser" in value &&
		typeof value.openInBrowser === "function" &&
		"signOut" in value &&
		typeof value.signOut === "function"
	);
}

/** The preload is the only ticket source. Clerk consumes each token once. */
export async function restoreDesktopSession(options: {
	bridge: ClawdiDesktopBridge | null;
	userId: string | null | undefined;
	consumeTicket: (ticket: string) => Promise<void>;
}): Promise<void> {
	if (!options.bridge) throw new Error("Open this page in Clawdi Desktop.");
	const { ticket, accountId } = await options.bridge.createDashboardSession();
	if (!ticket || ticket.length > 8192 || !accountId || accountId.length > 256)
		throw new Error("Invalid Desktop session.");
	if (options.userId) {
		if (options.userId !== accountId) throw new Error("Dashboard account mismatch.");
		return;
	}
	await options.consumeTicket(ticket);
}
