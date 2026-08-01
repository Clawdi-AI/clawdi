"use client";

import { Check, Copy, ExternalLink, QrCode } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
	pairCodeExpiryLabel,
	telegramPairDeepLink,
} from "@/hosted/v2/channels/channel-detail-page.logic";
import { pairCodeExpired } from "@/hosted/v2/channels/channel-linking.logic";
import { usePairingSuccess } from "@/hosted/v2/channels/channel-pairing-success";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";
import { useCreatePairCode } from "@/hosted/v2/channels/channels-hooks";
import {
	CopyablePairingCode,
	PairingDialogBody,
	PairingDialogContent,
	PairingDialogFooter,
	PairingDialogHeader,
	PairingExpiry,
	PairingInstructionPanel,
	PairingLoading,
	PairingNotice,
	PairingQrCode,
} from "@/hosted/v2/channels/pairing-dialog-ui";

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
			<PairingDialogContent data-hosted="true" data-v2="true">
				<PairingDialogHeader
					title="Pair Telegram"
					identity={botIdentity}
					scope="Private chat"
					description="Scan the QR code or open Telegram to pair a private chat."
				/>

				<PairingDialogBody data-telegram-pair-dialog-body>
					{generating ? (
						<PairingLoading>Creating a secure Telegram link…</PairingLoading>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void generate()}
							title="Couldn't create Telegram link"
						/>
					) : result ? (
						<div className="space-y-4">
							{validLink ? (
								<PairingQrCode value={validLink} label="Telegram pairing QR code" />
							) : (
								<PairingNotice
									title={expired ? "This Telegram link has expired" : "Telegram link unavailable"}
								>
									Create a new link to restore the QR and Telegram actions.
								</PairingNotice>
							)}
							<PairingExpiry expired={expired}>
								{pairCodeExpiryLabel(result.expires_at, nowMs)}
							</PairingExpiry>
							{!expired && result.bot_username ? (
								<PairingInstructionPanel>
									<details>
										<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
											Pair a group manually
										</summary>
										<div className="mt-3 space-y-3">
											<p>Add @{result.bot_username.replace(/^@/, "")} to the group, then send:</p>
											<CopyablePairingCode
												value={result.pairing_command}
												label="Telegram group pairing command"
											/>
										</div>
									</details>
								</PairingInstructionPanel>
							) : null}
						</div>
					) : null}
				</PairingDialogBody>

				{validLink ? (
					<PairingDialogFooter>
						<Button
							variant="outline"
							className="w-full min-w-0 whitespace-normal sm:w-auto"
							onClick={() => void copy(validLink)}
							aria-label={copied ? "Link copied" : "Copy link"}
							aria-live="polite"
						>
							{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
							{copied ? "Link copied" : "Copy link"}
						</Button>
						<Button
							render={<a href={validLink} target="_blank" rel="noopener noreferrer" />}
							nativeButton={false}
							className="w-full min-w-0 whitespace-normal sm:w-auto"
						>
							Open Telegram
							<ExternalLink className="size-4" />
						</Button>
					</PairingDialogFooter>
				) : result && !generating ? (
					<PairingDialogFooter>
						<Button
							className="w-full min-w-0 whitespace-normal sm:w-auto"
							onClick={() => void generate()}
						>
							<QrCode className="size-4" />
							{expired ? "Generate new link" : "Try again"}
						</Button>
					</PairingDialogFooter>
				) : null}
			</PairingDialogContent>
		</Dialog>
	);
}
