"use client";

import { Check, Copy, ExternalLink, QrCode } from "lucide-react";
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
import {
	pairCodeExpiryLabel,
	telegramPairDeepLink,
} from "@/hosted/v2/channels/channel-detail-page.logic";
import { pairCodeExpired } from "@/hosted/v2/channels/channel-linking.logic";
import { usePairingSuccess } from "@/hosted/v2/channels/channel-pairing-success";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import { CopyInline } from "@/hosted/v2/channels/channel-ui";
import { useCreatePairCode } from "@/hosted/v2/channels/channels-hooks";
import { cn } from "@/lib/utils";

const TELEGRAM_PAIR_TTL_SECONDS = 900;

type TelegramPairResult = {
	code: string;
	expires_at: string;
	pairing_command: string;
	bot_username: string | null;
	deep_link: string | null;
	qr_payload: string | null;
};

export function TelegramPairDialog({
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
		error: "Couldn't copy Telegram link",
	});
	const [result, setResult] = useState<TelegramPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [generating, setGenerating] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const openKeyRef = useRef<string | null>(null);
	const sessionRef = useRef(0);
	const lockedSessionRef = useRef<number | null>(null);
	const handlePairingOpenChange = usePairingSuccess({
		open,
		onOpenChange,
		accountId,
		agentLinkId,
		provider: "telegram",
		bindings,
	});

	const generate = useCallback(
		async (session = sessionRef.current) => {
			if (lockedSessionRef.current === session) return;
			lockedSessionRef.current = session;
			setGenerating(true);
			setRequestError(null);
			setResult(null);
			try {
				const data = await pair.execute({
					agent_link_id: agentLinkId,
					ttl_seconds: TELEGRAM_PAIR_TTL_SECONDS,
				});
				if (sessionRef.current !== session) return;
				setNowMs(Date.now());
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: data.pairing_command,
					bot_username: data.bot_username ?? null,
					deep_link: data.deep_link ?? null,
					qr_payload: data.qr_payload ?? null,
				});
			} catch (error) {
				if (sessionRef.current === session) setRequestError(error);
			} finally {
				if (lockedSessionRef.current === session) lockedSessionRef.current = null;
				if (sessionRef.current === session) setGenerating(false);
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
			setGenerating(false);
			setRequestError(null);
			setResult(null);
			return;
		}
		if (openKeyRef.current === openKey) return;
		openKeyRef.current = openKey;
		const session = sessionRef.current + 1;
		sessionRef.current = session;
		lockedSessionRef.current = null;
		void generate(session);
	}, [accountId, agentLinkId, generate, open]);

	useEffect(() => {
		if (!open || !result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [open, result]);

	const expired = result ? pairCodeExpired(result.expires_at, nowMs) : false;
	const validLink =
		result && !expired
			? telegramPairDeepLink({
					deepLink: result.deep_link,
					qrPayload: result.qr_payload,
					botUsername: result.bot_username,
					code: result.code,
				})
			: null;
	const botIdentity = result?.bot_username
		? `@${result.bot_username.replace(/^@/, "")}`
		: channelName?.trim() || "this bot";

	return (
		<Dialog open={open} onOpenChange={handlePairingOpenChange}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="h-[min(40rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:h-auto sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>Pair Telegram</DialogTitle>
					<p className="min-w-0 truncate text-sm font-medium" title={botIdentity}>
						{botIdentity}
					</p>
					<DialogDescription>Scan the QR code or open Telegram to pair.</DialogDescription>
				</DialogHeader>

				<div
					data-telegram-pair-dialog-body
					className="min-h-0 min-w-0 break-words overflow-y-auto overscroll-contain pr-1 [overflow-wrap:anywhere]"
				>
					{generating ? (
						<div className="flex min-h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
							<Spinner className="size-5" />
							<p>Creating a secure Telegram link…</p>
						</div>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void generate()}
							title="Couldn't create Telegram link"
						/>
					) : result ? (
						<div className="flex flex-col gap-4">
							{validLink ? (
								<div className="flex justify-center">
									<div className="max-w-full rounded-md border bg-white p-3 shadow-sm">
										<QRCodeSVG
											value={validLink}
											size={192}
											className="h-auto w-full max-w-48"
											role="img"
											aria-label="Telegram pairing QR code"
										/>
									</div>
								</div>
							) : (
								<div role="alert" className="rounded-lg border border-warning/40 bg-muted/20 p-4">
									<p className="text-sm font-medium">
										{expired ? "This Telegram link has expired" : "Telegram link unavailable"}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Create a new link to restore the QR and Telegram actions.
									</p>
								</div>
							)}
							<p
								role="status"
								className={cn(
									"text-center text-sm font-medium",
									expired ? "text-destructive" : "text-muted-foreground",
								)}
							>
								{pairCodeExpiryLabel(result.expires_at, nowMs)}
							</p>
							{!expired && result.bot_username ? (
								<details className="rounded-md border bg-muted/20 px-3 py-2">
									<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
										Pair a group manually
									</summary>
									<div className="mt-2 space-y-2">
										<p className="text-sm">
											Add @{result.bot_username.replace(/^@/, "")} to the group, then send:
										</p>
										<CopyInline value={result.pairing_command} label="pairing command" />
									</div>
								</details>
							) : null}
						</div>
					) : null}
				</div>

				{validLink ? (
					<DialogFooter>
						<Button
							variant="outline"
							className="min-w-0 whitespace-normal"
							onClick={() => void copy(validLink)}
						>
							{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
							{copied ? "Copied" : "Copy link"}
						</Button>
						<Button
							render={<a href={validLink} target="_blank" rel="noopener noreferrer" />}
							nativeButton={false}
							className="min-w-0 whitespace-normal"
						>
							Open Telegram
							<ExternalLink className="size-4" />
						</Button>
					</DialogFooter>
				) : result && !generating ? (
					<DialogFooter>
						<Button className="min-w-0 whitespace-normal" onClick={() => void generate()}>
							<QrCode className="size-4" />
							{expired ? "Generate new link" : "Try again"}
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
