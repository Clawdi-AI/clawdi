"use client";

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

function DesktopAuthPage() {
	const { isLoaded: authLoaded, isSignedIn } = useAuth();
	const { signIn } = useSignIn();
	const attempted = useRef(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!authLoaded || attempted.current) return;
		attempted.current = true;

		const params = new URLSearchParams(window.location.hash.slice(1));
		const ticket = params.get("ticket") ?? "";
		window.history.replaceState(null, "", window.location.pathname);
		if (isSignedIn) {
			window.location.replace("/");
			return;
		}
		if (!ticket || ticket.length > 8192) {
			setFailed(true);
			return;
		}

		void signIn
			.ticket({ ticket })
			.then(async ({ error }) => {
				if (error || signIn.status !== "complete") {
					setFailed(true);
					return;
				}
				const finalized = await signIn.finalize();
				if (finalized.error) {
					setFailed(true);
					return;
				}
				window.location.replace("/");
			})
			.catch(() => setFailed(true));
	}, [authLoaded, isSignedIn, signIn]);

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				{failed ? (
					<>
						<h1 className="text-lg font-semibold">Desktop sign-in expired</h1>
						<Button onClick={() => window.location.replace("/sign-in")}>Sign in</Button>
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
