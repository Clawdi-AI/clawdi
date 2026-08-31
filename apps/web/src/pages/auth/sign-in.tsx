"use client";

import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { SignIn } from "@clerk/tanstack-react-start";
import { LoaderCircle, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useDesktopBridge } from "@/lib/desktop";
import { env } from "@/lib/env";
import { DevAuthBypassPage } from "./dev-auth-bypass-page";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;

export default function SignInPage() {
	const desktopBridge = useDesktopBridge();
	if (desktopBridge === undefined) return null;
	if (desktopBridge) return <DesktopReconnect bridge={desktopBridge} />;
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-in" />;

	return (
		<main className="flex min-h-dvh items-center justify-center">
			<SignIn />
		</main>
	);
}

function DesktopReconnect({ bridge }: { bridge: ClawdiDesktopShellBridge }) {
	const [opening, setOpening] = useState(false);
	const [failed, setFailed] = useState(false);

	async function reconnect() {
		setOpening(true);
		setFailed(false);
		try {
			await bridge.openConnectWizard();
		} catch {
			setFailed(true);
		} finally {
			setOpening(false);
		}
	}

	return (
		<main className="flex min-h-dvh items-center justify-center p-6">
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<div className="space-y-1.5">
					<h1 className="text-lg font-semibold">Reconnect Clawdi Desktop</h1>
					<p className="text-sm text-muted-foreground">
						Desktop uses the account connected through the Clawdi CLI. Reconnect it to continue.
					</p>
					{failed ? (
						<p className="text-sm text-destructive">Connect Agent couldn't be opened. Try again.</p>
					) : null}
				</div>
				<Button disabled={opening} onClick={() => void reconnect()}>
					{opening ? <LoaderCircle className="animate-spin" /> : <TerminalSquare />}
					{opening ? "Opening…" : "Open Connect Agent"}
				</Button>
			</div>
		</main>
	);
}
