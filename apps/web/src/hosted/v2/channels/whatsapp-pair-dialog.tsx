"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import { pairCodeExpired } from "@/hosted/v2/channels/channel-linking.logic";
import { WHATSAPP_PAIR_ERROR_NORMALIZER } from "@/hosted/v2/channels/channel-pairing-errors";
import { usePairingSuccess } from "@/hosted/v2/channels/channel-pairing-success";
import type { ChannelPairCode } from "@/hosted/v2/channels/channel-types";
import { useCreatePairCode } from "@/hosted/v2/channels/channels-hooks";
import {
	CopyablePairingCode,
	PairingDialogActions,
	PairingDialogBody,
	PairingDialogContent,
	PairingDialogHeader,
	PairingExpiry,
	PairingInstructionPanel,
	PairingLoading,
	PairingNotice,
} from "@/hosted/v2/channels/pairing-dialog-ui";

const WHATSAPP_PAIR_TTL_SECONDS = 300;

type WhatsAppPairResult = Pick<ChannelPairCode, "expires_at" | "pairing_command">;

export function WhatsAppPairDialog({
	open,
	onOpenChange,
	onCloseComplete,
	agentId,
	accountId,
	agentLinkId,
	channelName,
	bindingCount,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseComplete?: () => void;
	agentId: string;
	accountId: string;
	agentLinkId: string;
	channelName?: string;
	bindingCount: number;
}) {
	const pair = useCreatePairCode(accountId, { agentId, toastOnError: false });
	const [result, setResult] = useState<WhatsAppPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [generating, setGenerating] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const openKeyRef = useRef<string | null>(null);
	const sessionRef = useRef(0);
	const lockedSessionRef = useRef<number | null>(null);
	const invalidatePendingSession = useCallback(() => {
		openKeyRef.current = null;
		sessionRef.current += 1;
		lockedSessionRef.current = null;
	}, []);
	const requestOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) invalidatePendingSession();
			onOpenChange(nextOpen);
		},
		[invalidatePendingSession, onOpenChange],
	);
	const handlePairingOpenChange = usePairingSuccess({
		open,
		onOpenChange: requestOpenChange,
		accountId,
		agentLinkId,
		provider: "whatsapp",
		bindingCount,
	});

	const generate = useCallback(
		async (session = sessionRef.current) => {
			if (lockedSessionRef.current === session) return;
			lockedSessionRef.current = session;
			setGenerating(true);
			setRequestError(null);
			setResult(null);
			try {
				if (sessionRef.current !== session) return;
				const data = await pair.execute({
					agent_link_id: agentLinkId,
					ttl_seconds: WHATSAPP_PAIR_TTL_SECONDS,
				});
				if (sessionRef.current !== session) return;
				setNowMs(Date.now());
				setResult({
					expires_at: data.expires_at,
					pairing_command: data.pairing_command,
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
			if (openKeyRef.current !== null) invalidatePendingSession();
			return;
		}
		if (openKeyRef.current === openKey) return;
		openKeyRef.current = openKey;
		const session = sessionRef.current + 1;
		sessionRef.current = session;
		lockedSessionRef.current = null;
		void generate(session);
	}, [accountId, agentLinkId, generate, invalidatePendingSession, open]);

	useEffect(() => {
		if (!open || !result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [open, result]);

	const expired = result ? pairCodeExpired(result.expires_at, nowMs) : false;
	const accountIdentity = channelName?.trim() || "this WhatsApp account";

	return (
		<Dialog
			open={open}
			onOpenChange={handlePairingOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (nextOpen) return;
				setGenerating(false);
				setRequestError(null);
				setResult(null);
				onCloseComplete?.();
			}}
		>
			<PairingDialogContent data-hosted="true" data-v2="true">
				<PairingDialogHeader
					title="Pair WhatsApp"
					identity={accountIdentity}
					description="Send the one-time command in the WhatsApp chat you want to connect."
				/>

				<PairingDialogBody data-whatsapp-pair-dialog-body>
					{generating ? (
						<PairingLoading>Creating a WhatsApp pair code…</PairingLoading>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void generate()}
							title="Couldn't prepare WhatsApp pairing"
							normalizer={WHATSAPP_PAIR_ERROR_NORMALIZER}
						/>
					) : result ? (
						<div className="space-y-4">
							{expired ? (
								<PairingNotice title="This WhatsApp pair code has expired">
									Generate a new command before pairing WhatsApp.
								</PairingNotice>
							) : (
								<PairingInstructionPanel>
									<p>Send this command in the WhatsApp chat you want to connect:</p>
									<CopyablePairingCode
										value={result.pairing_command}
										label="WhatsApp pairing command"
									/>
								</PairingInstructionPanel>
							)}
							<PairingExpiry expired={expired}>
								{expired
									? "Expired — generate a new code"
									: pairCodeExpiryLabel(result.expires_at, nowMs)}
							</PairingExpiry>
							<PairingDialogActions className="sm:grid-cols-1">
								<Button
									variant={expired ? "default" : "outline"}
									className="w-full min-w-0 whitespace-normal"
									onClick={() => void generate()}
								>
									<RefreshCw className="size-4" />
									Generate new code
								</Button>
							</PairingDialogActions>
						</div>
					) : null}
				</PairingDialogBody>
			</PairingDialogContent>
		</Dialog>
	);
}
