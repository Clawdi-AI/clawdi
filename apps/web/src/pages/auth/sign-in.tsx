"use client";

import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { SignIn } from "@clerk/tanstack-react-start";
import { LoaderCircle, LogIn } from "lucide-react";
import { useState } from "react";
import { DesktopWindowDragRegion } from "@/components/desktop-window-drag-region";
import { Button } from "@/components/ui/button";
import { useDesktopBridge } from "@/lib/desktop";
import { env } from "@/lib/env";
import { DevAuthBypassPage } from "./dev-auth-bypass-page";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;

export default function SignInPage() {
	const desktopBridge = useDesktopBridge();
	if (desktopBridge === undefined) return null;
	if (desktopBridge) return <DesktopSignIn bridge={desktopBridge} />;
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-in" />;

	return (
		<main className="flex min-h-dvh items-center justify-center">
			<SignIn />
		</main>
	);
}

function DesktopSignIn({ bridge }: { bridge: ClawdiDesktopShellBridge }) {
	const [opening, setOpening] = useState<"retry" | "sign-in" | null>(null);
	const [failed, setFailed] = useState(false);

	async function reconnect(action: "retry" | "sign-in") {
		setOpening(action);
		setFailed(false);
		try {
			await (action === "retry" ? bridge.retryDashboard() : bridge.signIn());
		} catch {
			setFailed(true);
		} finally {
			setOpening(null);
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center p-6">
			<DesktopWindowDragRegion />
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<div className="space-y-1.5">
					<h1 className="text-lg font-semibold">Reconnect Clawdi</h1>
					<p className="text-sm text-muted-foreground">
						Clawdi will first restore the Dashboard from your local sign-in. If it has expired, you
						can sign in again securely in your browser.
					</p>
					{failed ? <p className="text-sm text-destructive">Clawdi couldn't reconnect.</p> : null}
				</div>
				<div className="flex items-center gap-2">
					{failed ? (
						<Button
							disabled={opening !== null}
							onClick={() => void reconnect("sign-in")}
							variant="outline"
						>
							<LogIn /> Sign in again
						</Button>
					) : null}
					<Button disabled={opening !== null} onClick={() => void reconnect("retry")}>
						{opening === "retry" ? <LoaderCircle className="animate-spin" /> : <LogIn />}
						{opening === "retry" ? "Reconnecting…" : "Reconnect"}
					</Button>
				</div>
			</div>
		</main>
	);
}
