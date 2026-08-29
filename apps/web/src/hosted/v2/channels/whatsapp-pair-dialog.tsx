"use client";

import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import {
	pairCodeExpired,
	verifiedWhatsAppPairLink,
} from "@/hosted/v2/channels/channel-linking.logic";
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
	PairingQrCode,
} from "@/hosted/v2/channels/pairing-dialog-ui";
import { WhatsAppDeviceOnboarding } from "@/hosted/v2/channels/whatsapp-device-onboarding";
import { ApiError } from "@/lib/api";

const WHATSAPP_PAIR_TTL_SECONDS = 300;

type WhatsAppPairResult = Pick<
	ChannelPairCode,
	"code" | "expires_at" | "pairing_command" | "deep_link" | "qr_payload"
>;

export function WhatsAppPairDialog({
	open,
	onOpenChange,
	onCloseComplete,
	agentId,
	accountId,
	agentLinkId,
	channelName,
	bindingCount,
	baselineBindingCount,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseComplete?: () => void;
	agentId: string;
	accountId: string;
	agentLinkId: string;
	channelName?: string;
	bindingCount: number;
	baselineBindingCount?: number;
}) {
	const pair = useCreatePairCode(accountId, { agentId, toastOnError: false });
	const { copied, copy } = useCopyToClipboard({
		success: false,
		error: "Couldn't copy WhatsApp link",
	});
	const [result, setResult] = useState<WhatsAppPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [generating, setGenerating] = useState(false);
	const [repairing, setRepairing] = useState(false);
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
		baselineBindingCount,
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
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: data.pairing_command,
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
	const validLink =
		result && !expired
			? verifiedWhatsAppPairLink({
					deepLink: result.deep_link,
					qrPayload: result.qr_payload,
					pairingCommand: result.pairing_command,
					code: result.code,
				})
			: null;
	const accountIdentity = channelName?.trim() || "this WhatsApp account";
	const repairRequired =
		requestError instanceof ApiError &&
		requestError.status === 409 &&
		requestError.detail === "whatsapp_repair_required";

	return (
		<Dialog
			open={open}
			onOpenChange={handlePairingOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (nextOpen) return;
				setGenerating(false);
				setRepairing(false);
				setRequestError(null);
				setResult(null);
				onCloseComplete?.();
			}}
		>
			<PairingDialogContent data-hosted="true" data-v2="true">
				<PairingDialogHeader
					title="Pair WhatsApp"
					identity={accountIdentity}
					description="Use the link or pairing command to connect a chat."
				/>

				<PairingDialogBody data-whatsapp-pair-dialog-body>
					{generating ? (
						<PairingLoading>Creating a WhatsApp pair code…</PairingLoading>
					) : repairRequired ? (
						repairing ? (
							<WhatsAppDeviceOnboarding
								repairAccountId={accountId}
								onDone={() => {
									setRepairing(false);
									setRequestError(null);
									void generate();
								}}
							/>
						) : (
							<div className="space-y-4">
								<PairingNotice title="WhatsApp needs repair before pairing">
									Reconnect this Custom WhatsApp account first. The bot, Agent Links, paired chats,
									and history stay unchanged.
								</PairingNotice>
								<PairingDialogActions>
									<Button variant="outline" onClick={() => requestOpenChange(false)}>
										Cancel
									</Button>
									<Button onClick={() => setRepairing(true)}>Repair WhatsApp</Button>
								</PairingDialogActions>
							</div>
						)
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void generate()}
							title="Couldn't prepare WhatsApp pairing"
							normalizer={WHATSAPP_PAIR_ERROR_NORMALIZER}
						/>
					) : result ? (
						<div className="space-y-4">
							{validLink ? (
								<PairingQrCode value={validLink} label="WhatsApp pairing QR code" />
							) : (
								<PairingNotice
									title={
										expired ? "This WhatsApp pair code has expired" : "WhatsApp link unavailable"
									}
								>
									{expired
										? "Generate a new code before pairing WhatsApp."
										: "QR and Open WhatsApp aren't available for this account. Use the command below instead."}
								</PairingNotice>
							)}
							<PairingExpiry expired={expired}>
								{expired
									? "Expired — generate a new code"
									: pairCodeExpiryLabel(result.expires_at, nowMs)}
							</PairingExpiry>
							{validLink ? (
								<PairingDialogActions>
									<Button
										render={<a href={validLink} target="_blank" rel="noopener noreferrer" />}
										nativeButton={false}
										className="w-full min-w-0 whitespace-normal"
									>
										Open WhatsApp
										<ExternalLink className="size-4" />
									</Button>
									<Button
										variant="outline"
										className="w-full min-w-0 whitespace-normal"
										onClick={() => void copy(validLink)}
										aria-label={copied ? "WhatsApp link copied" : "Copy WhatsApp link"}
										aria-live="polite"
									>
										{copied ? <Check className="size-4" /> : <Copy className="size-4" />}
										{copied ? "Link copied" : "Copy link"}
									</Button>
								</PairingDialogActions>
							) : null}
							{!expired ? (
								<PairingInstructionPanel>
									{validLink ? (
										<details>
											<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
												Pair manually
											</summary>
											<div className="mt-3 space-y-2">
												<p>Send this in the WhatsApp chat you want to connect:</p>
												<CopyablePairingCode
													value={result.pairing_command}
													label="WhatsApp pairing command"
												/>
											</div>
										</details>
									) : (
										<>
											<p>Send this in the WhatsApp chat you want to connect:</p>
											<CopyablePairingCode
												value={result.pairing_command}
												label="WhatsApp pairing command"
											/>
										</>
									)}
								</PairingInstructionPanel>
							) : null}
							{!validLink ? (
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
							) : null}
						</div>
					) : null}
				</PairingDialogBody>
			</PairingDialogContent>
		</Dialog>
	);
}
