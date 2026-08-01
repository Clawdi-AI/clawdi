"use client";

import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import {
	pairCodeExpired,
	verifiedDiscordPairingCommand,
} from "@/hosted/v2/channels/channel-linking.logic";
import { usePairingSuccess } from "@/hosted/v2/channels/channel-pairing-success";
import type { ChannelBinding, ChannelPairCode } from "@/hosted/v2/channels/channel-types";
import { useCreatePairCode } from "@/hosted/v2/channels/channels-hooks";

const DISCORD_PAIR_TTL_SECONDS = 900;

type DiscordPairResult = Pick<
	ChannelPairCode,
	"code" | "expires_at" | "pairing_command" | "discord_install_url"
>;

export function DiscordPairDialog({
	open,
	onOpenChange,
	accountId,
	agentLinkId,
	channelName,
	bindings,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	agentLinkId: string;
	channelName?: string;
	bindings?: readonly ChannelBinding[];
}) {
	const pair = useCreatePairCode(accountId, { toastOnError: false });
	const { copied, copy } = useCopyToClipboard({
		success: false,
		error: "Couldn't copy Discord pair code",
	});
	const [result, setResult] = useState<DiscordPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [preparing, setPreparing] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const openKeyRef = useRef<string | null>(null);
	const sessionRef = useRef(0);
	const lockedSessionRef = useRef<number | null>(null);
	const handlePairingOpenChange = usePairingSuccess({
		open,
		onOpenChange,
		accountId,
		agentLinkId,
		provider: "discord",
		bindings,
	});

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
				const pairingCommand = verifiedDiscordPairingCommand(data.pairing_command, data.code);
				if (pairingCommand === null) {
					throw new Error("Discord pairing instructions are out of date. Refresh and try again.");
				}
				setNowMs(Date.now());
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: pairingCommand,
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
	const botIdentity = channelName?.trim() || "this bot";

	return (
		<Dialog open={open} onOpenChange={handlePairingOpenChange}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="h-[min(40rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:h-auto sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>Pair Discord</DialogTitle>
					<p className="min-w-0 truncate text-sm font-medium" title={botIdentity}>
						{botIdentity}
					</p>
					<DialogDescription>Add the bot to a server, then pair that server.</DialogDescription>
				</DialogHeader>

				<div
					data-discord-pair-dialog-body
					className="min-h-0 min-w-0 break-words overflow-y-auto overscroll-contain pr-1 [overflow-wrap:anywhere]"
				>
					{preparing ? (
						<div className="flex min-h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
							<Spinner className="size-5" />
							<p>Creating a Discord pair code…</p>
						</div>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void prepare()}
							title="Couldn't prepare Discord pairing"
						/>
					) : result ? (
						expired ? (
							<div role="alert" className="rounded-lg border border-warning/40 bg-muted/20 p-4">
								<p className="text-sm font-medium">This Discord pair code has expired</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Create a new code before pairing a server.
								</p>
							</div>
						) : (
							<div data-discord-pair-path="server" className="space-y-4">
								{result.discord_install_url ? (
									<div className="flex justify-center">
										<div className="max-w-full rounded-md border bg-white p-3 shadow-sm">
											<QRCodeSVG
												value={result.discord_install_url}
												size={192}
												className="h-auto w-full max-w-48"
												role="img"
												aria-label="Discord server install QR code"
											/>
										</div>
									</div>
								) : (
									<div role="alert" className="rounded-lg border border-warning/40 bg-muted/20 p-3">
										<p className="text-sm font-medium">Server install unavailable</p>
										<p className="mt-1 text-xs text-muted-foreground">
											Use a server where this bot is already installed, or ask the bot owner for a
											valid server install link.
										</p>
									</div>
								)}
								<div className="space-y-2 border-t pt-3 text-sm">
									<p>
										{result.discord_install_url
											? "1. Add the bot to the server. You need Manage Server or Administrator."
											: "1. Open a server where this bot is already installed. You need Manage Server or Administrator."}
									</p>
									<p>
										2. In that server, run <code>{result.pairing_command.split(" ", 1)[0]}</code>{" "}
										and paste this code into the required <code>code</code> option.
									</p>
									<DiscordPairCode code={result.code} />
								</div>
								<p role="status" className="text-center text-sm text-muted-foreground">
									{pairCodeExpiryLabel(result.expires_at, nowMs)}
								</p>
							</div>
						)
					) : null}
				</div>

				{result && !expired ? (
					<DialogFooter>
						<Button
							variant="outline"
							className="min-w-0 whitespace-normal"
							onClick={() => void copy(result.code)}
						>
							{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
							{copied ? "Code copied" : "Copy code"}
						</Button>
						{result.discord_install_url ? (
							<Button
								render={
									<a href={result.discord_install_url} target="_blank" rel="noopener noreferrer" />
								}
								nativeButton={false}
								className="min-w-0 whitespace-normal"
							>
								Add to server
								<ExternalLink className="size-4" />
							</Button>
						) : null}
					</DialogFooter>
				) : result && expired ? (
					<DialogFooter>
						<Button className="min-w-0 whitespace-normal" onClick={() => void prepare()}>
							<RefreshCw className="size-4" />
							Generate new code
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function DiscordPairCode({ code }: { code: string }) {
	return (
		<div className="flex min-w-0 items-center justify-between gap-3 border-y py-3">
			<span className="text-xs font-medium text-muted-foreground">Required code</span>
			<code className="min-w-0 break-all text-right text-sm font-medium">{code}</code>
		</div>
	);
}
