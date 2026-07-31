"use client";

import { CircleAlert, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

export type OAuthIssue = "blocked" | "closed" | "expired";

export function ProviderOAuthFlow({
	issue,
	callbackUrl,
	starting,
	completing,
	onCallbackUrlChange,
	onRestart,
	onFinish,
}: {
	issue: OAuthIssue | null;
	callbackUrl: string;
	starting: boolean;
	completing: boolean;
	onCallbackUrlChange: (value: string) => void;
	onRestart: () => void;
	onFinish: () => void;
}) {
	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-3">
			<Button
				variant="outline"
				className="w-full"
				onClick={onRestart}
				disabled={starting || completing}
			>
				{issue ? "Restart ChatGPT sign-in" : "Open a fresh ChatGPT sign-in"}
				{starting ? <Spinner className="size-3.5" /> : <ExternalLink className="size-3.5" />}
			</Button>
			<div aria-live="polite">
				{issue === "expired" ? (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<CircleAlert className="size-3.5" /> This sign-in link expired. Restart to get a fresh
						one.
					</p>
				) : issue === "blocked" ? (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<CircleAlert className="size-3.5" /> Pop-up blocked. Allow pop-ups, then restart.
					</p>
				) : issue === "closed" ? (
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<CircleAlert className="size-3.5" /> The sign-in window closed before finishing.
					</p>
				) : completing ? (
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<Spinner className="size-3.5" /> Connecting Codex…
					</p>
				) : (
					<p className="flex items-center gap-2 text-xs text-muted-foreground">
						<Spinner className="size-3.5" /> Waiting for sign-in to finish…
					</p>
				)}
			</div>
			<details className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
				<summary className="cursor-pointer font-medium text-foreground">
					Didn’t return automatically?
				</summary>
				<div className="mt-2 flex flex-col gap-2">
					<p>Paste the full callback address from the OpenAI page.</p>
					<Label htmlFor="provider-oauth-callback" className="sr-only">
						OAuth callback URL
					</Label>
					<Input
						id="provider-oauth-callback"
						value={callbackUrl}
						onChange={(event) => onCallbackUrlChange(event.target.value)}
						placeholder="https://…/callback?code=…&state=…"
						autoComplete="off"
						spellCheck={false}
					/>
					<Button size="sm" onClick={onFinish} disabled={!callbackUrl.trim() || completing}>
						{completing ? (
							<>
								<Spinner /> Finishing sign-in…
							</>
						) : (
							"Finish sign-in"
						)}
					</Button>
				</div>
			</details>
		</div>
	);
}
