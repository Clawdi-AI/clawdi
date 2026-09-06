"use client";

import { useAuth, useSignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DesktopWindowDragRegion } from "@/components/desktop-window-drag-region";
import { Button } from "@/components/ui/button";
import { useDesktopBridge } from "@/lib/desktop";
import { restoreDesktopSession } from "@/lib/desktop-session";
import { routeHeadTitle } from "@/lib/document-title";

export const Route = createFileRoute("/desktop-auth")({
	head: () => routeHeadTitle("Signing in"),
	component: DesktopAuthPage,
});

function DesktopAuthPage() {
	const { isLoaded: authLoaded, isSignedIn, userId } = useAuth();
	const { signIn } = useSignIn();
	const desktopBridge = useDesktopBridge();
	const attempted = useRef(false);
	const [failed, setFailed] = useState(false);
	const [recovering, setRecovering] = useState<"retry" | "sign-in" | null>(null);

	async function recover(action: "retry" | "sign-in") {
		if (desktopBridge) {
			setRecovering(action);
			try {
				await (action === "retry" ? desktopBridge.retryDashboard() : desktopBridge.signIn());
			} catch {
				setFailed(true);
			} finally {
				setRecovering(null);
			}
			return;
		}
		window.location.replace("/sign-in");
	}

	useEffect(() => {
		if (!authLoaded || desktopBridge === undefined || attempted.current) return;
		attempted.current = true;

		const params = new URLSearchParams(window.location.hash.slice(1));
		const account = params.get("account");
		window.history.replaceState(null, "", window.location.pathname);
		void restoreDesktopSession({
			userId: isSignedIn ? userId : null,
			accountId: desktopBridge ? account : userId || "browser",
			createTicket: () =>
				desktopBridge
					? desktopBridge.createDashboardSession()
					: Promise.resolve(params.get("ticket") ?? ""),
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
			{desktopBridge ? <DesktopWindowDragRegion /> : null}
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				{failed ? (
					<>
						<h1 className="text-lg font-semibold">Desktop sign-in expired</h1>
						{desktopBridge ? (
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
						) : (
							<Button onClick={() => void recover("sign-in")}>Sign in</Button>
						)}
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
