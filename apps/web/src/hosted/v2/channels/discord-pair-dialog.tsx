"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import { pairCodeExpired } from "@/hosted/v2/channels/channel-linking.logic";
import type { ChannelPairCode } from "@/hosted/v2/channels/channel-types";
import { CopyInline } from "@/hosted/v2/channels/channel-ui";
import { useCreatePairCode } from "@/hosted/v2/channels/channels-hooks";

const DISCORD_PAIR_TTL_SECONDS = 900;

type DiscordPairResult = Pick<ChannelPairCode, "code" | "expires_at" | "discord_install_url">;

export function DiscordPairDialog({
	open,
	onOpenChange,
	accountId,
	agentLinkId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	agentLinkId: string;
}) {
	const pair = useCreatePairCode(accountId);
	const [result, setResult] = useState<DiscordPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [preparing, setPreparing] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const openKeyRef = useRef<string | null>(null);
	const sessionRef = useRef(0);
	const lockedSessionRef = useRef<number | null>(null);

	const prepare = useCallback(
		async (session = sessionRef.current) => {
			if (lockedSessionRef.current === session) return;
			lockedSessionRef.current = session;
			setPreparing(true);
			setRequestError(null);
			setResult(null);
			try {
				if (sessionRef.current !== session) return;
				const data = await pair.execute({
					agent_link_id: agentLinkId,
					ttl_seconds: DISCORD_PAIR_TTL_SECONDS,
				});
				if (sessionRef.current !== session) return;
				setNowMs(Date.now());
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					discord_install_url: data.discord_install_url,
				});
			} catch (error) {
				if (sessionRef.current === session) setRequestError(error);
			} finally {
				if (lockedSessionRef.current === session) lockedSessionRef.current = null;
				if (sessionRef.current === session) setPreparing(false);
			}
		},
		[agentLinkId, pair.execute],
	);

	useEffect(() => {
		const openKey = open ? `${accountId}:${agentLinkId}` : null;
		if (!openKey) {
			openKeyRef.current = null;
			sessionRef.current += 1;
			lockedSessionRef.current = null;
			setPreparing(false);
			setRequestError(null);
			setResult(null);
			return;
		}
		if (openKeyRef.current === openKey) return;
		openKeyRef.current = openKey;
		const session = sessionRef.current + 1;
		sessionRef.current = session;
		lockedSessionRef.current = null;
		void prepare(session);
	}, [accountId, agentLinkId, open, prepare]);

	useEffect(() => {
		if (!open || !result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [open, result]);

	const expired = result ? pairCodeExpired(result.expires_at, nowMs) : false;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pair Discord</DialogTitle>
					<DialogDescription>Connect one server or direct message to this Agent.</DialogDescription>
				</DialogHeader>

				<div data-discord-pair-dialog-body className="min-h-36">
					{preparing ? (
						<div className="flex min-h-36 flex-col items-center justify-center gap-3 text-muted-foreground">
							<Spinner className="size-5" />
							<p>Preparing Discord and creating a pair code…</p>
						</div>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void prepare()}
							title="Couldn't prepare Discord pairing"
						/>
					) : result ? (
						<div className="space-y-4">
							<div data-discord-pair-path="server" className="space-y-1">
								<p className="text-sm font-medium">Server</p>
								<p className="text-sm text-muted-foreground">
									Add the bot, then run <code>/bot_pair</code> in that server. You need Manage
									Server.
								</p>
								{result.discord_install_url ? (
									<Button
										variant="outline"
										size="sm"
										render={
											<a href={result.discord_install_url} target="_blank" rel="noreferrer" />
										}
										nativeButton={false}
									>
										Add to server
										<ExternalLink className="size-3.5" />
									</Button>
								) : null}
							</div>
							<div data-discord-pair-path="dm" className="space-y-1 border-t pt-3">
								<p className="text-sm font-medium">Direct message</p>
								<p className="text-sm text-muted-foreground">
									If you share a server with the bot or can already open its DM, message it and run{" "}
									<code>/bot_pair</code>. No server permission is required.
								</p>
							</div>
							<p className="text-sm text-muted-foreground">Enter this code when prompted:</p>
							{expired ? null : <CopyInline value={result.code} label="pair code" />}
							<p
								role="status"
								className={expired ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
							>
								{pairCodeExpiryLabel(result.expires_at, nowMs)}
							</p>
						</div>
					) : null}
				</div>

				{result && expired ? (
					<DialogFooter>
						<Button onClick={() => void prepare()}>
							<RefreshCw className="size-4" />
							Generate new code
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
