"use client";

import { RefreshCw } from "lucide-react";
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
import {
	pairCodeExpired,
	prepareProviderPairing,
} from "@/hosted/v2/channels/channel-linking.logic";
import { CopyInline } from "@/hosted/v2/channels/channel-ui";
import { useCreatePairCode, useSyncCommands } from "@/hosted/v2/channels/channels-hooks";

const DISCORD_PAIR_TTL_SECONDS = 900;

type DiscordPairResult = {
	code: string;
	expires_at: string;
};

export function DiscordPairDialog({
	open,
	onOpenChange,
	accountId,
	agentLinkId,
	syncCommandsBeforePairing,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	agentLinkId: string;
	syncCommandsBeforePairing: boolean;
}) {
	const syncCommands = useSyncCommands(accountId);
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
				const data = await prepareProviderPairing({
					provider: "discord",
					syncCommands: syncCommandsBeforePairing ? () => syncCommands.mutateAsync() : undefined,
					createPairCode: () =>
						pair.execute({
							agent_link_id: agentLinkId,
							ttl_seconds: DISCORD_PAIR_TTL_SECONDS,
						}),
				});
				if (sessionRef.current !== session) return;
				setNowMs(Date.now());
				setResult({ code: data.code, expires_at: data.expires_at });
			} catch (error) {
				if (sessionRef.current === session) setRequestError(error);
			} finally {
				if (lockedSessionRef.current === session) lockedSessionRef.current = null;
				if (sessionRef.current === session) setPreparing(false);
			}
		},
		[agentLinkId, pair.execute, syncCommands.mutateAsync, syncCommandsBeforePairing],
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
							<p>
								{syncCommandsBeforePairing
									? "Syncing commands and creating a pair code…"
									: "Creating a Discord pair code…"}
							</p>
						</div>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void prepare()}
							title="Couldn't prepare Discord pairing"
						/>
					) : result ? (
						<div className="space-y-4">
							<p className="text-sm text-muted-foreground">
								{syncCommandsBeforePairing ? "Commands synced. " : null}
								In Discord, run <code>/bot_pair</code> and enter this code in the server or direct
								message you want to connect. Pairing a server requires Manage Server.
							</p>
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
