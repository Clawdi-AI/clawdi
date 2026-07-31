"use client";

import { Check, CircleAlert, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type OAuthIssue = "expired" | "failed";

export function ProviderOAuthFlow({
	issue,
	verificationUrl,
	userCode,
	starting,
	polling,
	onRestart,
}: {
	issue: OAuthIssue | null;
	verificationUrl: string;
	userCode: string;
	starting: boolean;
	polling: boolean;
	onRestart: () => void;
}) {
	const [copied, setCopied] = useState(false);

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Couldn't copy the code");
		}
	}

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-4">
			<div className="rounded-lg border bg-muted/20 p-4 text-center">
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					One-time code
				</p>
				<div className="mt-2 flex items-center justify-center gap-2">
					<code className="rounded-md bg-background px-3 py-2 font-mono text-xl font-semibold tracking-widest">
						{userCode}
					</code>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => void copyCode()}
						aria-label="Copy code"
					>
						{copied ? <Check /> : <Copy />}
					</Button>
				</div>
			</div>

			<Button
				render={<a href={verificationUrl} target="_blank" rel="noreferrer" />}
				nativeButton={false}
				className="w-full"
			>
				Open ChatGPT and enter code <ExternalLink />
			</Button>

			<div aria-live="polite">
				{issue === "expired" ? (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<CircleAlert className="size-3.5" /> This code expired. Start again for a new code.
					</p>
				) : issue === "failed" ? (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<CircleAlert className="size-3.5" /> Sign-in could not be completed. Start again and
						retry.
					</p>
				) : (
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						{polling ? <Spinner className="size-3.5" /> : null} Waiting for ChatGPT authorization…
					</p>
				)}
			</div>

			<Button variant="outline" onClick={onRestart} disabled={starting}>
				{starting ? <Spinner /> : null}
				Get a new code
			</Button>
		</div>
	);
}
