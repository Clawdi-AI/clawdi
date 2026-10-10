import {
	type ClawdiDesktopBridge,
	type DesktopWebSession,
	isClawdiDesktopBridge,
} from "@clawdi/shared/desktop";
import { useAuth, useClerk, useSignIn } from "@clerk/tanstack-react-start";
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
		setDesktopBridge(isClawdiDesktopBridge(candidate) ? candidate : null);
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
	const { isLoaded: authLoaded, isSignedIn, userId, sessionId } = useAuth();
	const { signIn } = useSignIn();
	const clerk = useClerk();
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
			session: isSignedIn && userId && sessionId ? { userId, sessionId } : null,
			signOut: () => clerk.signOut(() => undefined),
			consumeTicket: async (ticket) => {
				const { error } = await signIn.ticket({ ticket });
				if (error || signIn.status !== "complete") throw new Error("Sign-in failed.");
				const finalized = await signIn.finalize();
				if (finalized.error) throw new Error("Sign-in finalization failed.");
			},
		})
			.then((consumed) => window.location.replace(consumed ? "/desktop-auth" : "/"))
			.catch(() => setFailed(true));
	}, [authLoaded, desktopBridge, isSignedIn, signIn, userId, sessionId, clerk]);

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

/** The preload is the only ticket source. Clerk consumes each token once. */
export async function restoreDesktopSession(options: {
	bridge: ClawdiDesktopBridge | null;
	session: DesktopWebSession | null;
	signOut: () => Promise<void>;
	consumeTicket: (ticket: string) => Promise<void>;
}): Promise<boolean> {
	if (!options.bridge) throw new Error("Open this page in Clawdi Desktop.");
	let result = await options.bridge.createDashboardSession(options.session);
	if (result.status === "sign-out") {
		if (!options.session) throw new Error("Invalid Desktop session.");
		// Revoke the previous account's Clerk session before minting a new ticket.
		await options.signOut();
		result = await options.bridge.createDashboardSession(null);
	}
	if (!result.accountId || result.accountId.length > 256)
		throw new Error("Invalid Desktop session.");
	if (result.status === "signed-in") {
		if (options.session?.userId !== result.accountId)
			throw new Error("Dashboard account mismatch.");
		return false;
	}
	if (result.status !== "ticket" || !result.ticket || result.ticket.length > 8192)
		throw new Error("Invalid Desktop session.");
	await options.consumeTicket(result.ticket);
	return true;
}
