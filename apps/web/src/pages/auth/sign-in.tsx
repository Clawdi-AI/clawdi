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
	const [opening, setOpening] = useState(false);
	const [failed, setFailed] = useState(false);

	async function signIn() {
		setOpening(true);
		setFailed(false);
		try {
			await bridge.signIn();
		} catch {
			setFailed(true);
		} finally {
			setOpening(false);
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center p-6">
			<DesktopWindowDragRegion />
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<div className="space-y-1.5">
					<h1 className="text-lg font-semibold">Reconnect Clawdi</h1>
					<p className="text-sm text-muted-foreground">
						Clawdi will restore the Dashboard from your local sign-in. If that sign-in expired, your
						browser opens for secure authorization.
					</p>
					{failed ? (
						<p className="text-sm text-destructive">Sign-in couldn't be started. Try again.</p>
					) : null}
				</div>
				<Button disabled={opening} onClick={() => void signIn()}>
					{opening ? <LoaderCircle className="animate-spin" /> : <LogIn />}
					{opening ? "Reconnecting…" : "Reconnect"}
				</Button>
			</div>
		</main>
	);
}
