"use client";

import { Check, Copy, ExternalLink, MessageCircle, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import {
	pairCodeExpired,
	verifiedDiscordInstallUrl,
	verifiedDiscordPairingCommand,
} from "@/hosted/v2/channels/channel-linking.logic";
import { DISCORD_PAIR_ERROR_NORMALIZER } from "@/hosted/v2/channels/channel-pairing-errors";
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

const DISCORD_PAIR_TTL_SECONDS = 300;

type DiscordPairResult = Pick<ChannelPairCode, "code" | "expires_at" | "pairing_command"> & {
	discord_install_url: string | null;
	discord_user_install_url: string | null;
	server_install_retryable: boolean;
};

export function DiscordPairDialog({
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
	const { copied: installLinkCopied, copy: copyInstallLink } = useCopyToClipboard({
		success: false,
		error: "Couldn't copy Discord install link",
	});
	const [result, setResult] = useState<DiscordPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [preparing, setPreparing] = useState(false);
	const [path, setPath] = useState<"server" | "dm">("server");
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
		provider: "discord",
		bindingCount,
	});

	const prepare = useCallback(
		async (session = sessionRef.current) => {
			if (lockedSessionRef.current === session) return;
			lockedSessionRef.current = session;
			setPreparing(true);
			setPath("server");
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
					throw new Error("Discord pairing response failed validation.");
				}
				const serverInstallUrl = verifiedDiscordInstallUrl(data.discord_install_url);
				const userInstallUrl = verifiedDiscordInstallUrl(data.discord_user_install_url);
				const serverInstallRetryable = Boolean(data.discord_install_url && !serverInstallUrl);
				setNowMs(Date.now());
				setPath(serverInstallUrl || !userInstallUrl ? "server" : "dm");
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: pairingCommand,
					discord_install_url: serverInstallUrl,
					discord_user_install_url: userInstallUrl,
					server_install_retryable: serverInstallRetryable,
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
			if (openKeyRef.current !== null) invalidatePendingSession();
			return;
		}
		if (openKeyRef.current === openKey) return;
		openKeyRef.current = openKey;
		const session = sessionRef.current + 1;
		sessionRef.current = session;
		lockedSessionRef.current = null;
		void prepare(session);
	}, [accountId, agentLinkId, invalidatePendingSession, open, prepare]);

	useEffect(() => {
		if (!open || !result) return;
		setNowMs(Date.now());
		const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
		return () => window.clearInterval(interval);
	}, [open, result]);

	const expired = result ? pairCodeExpired(result.expires_at, nowMs) : false;
	const botIdentity = channelName?.trim() || "this bot";
	return (
		<Dialog
			open={open}
			onOpenChange={handlePairingOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (nextOpen) return;
				setPath("server");
				setPreparing(false);
				setRequestError(null);
				setResult(null);
				onCloseComplete?.();
			}}
		>
			<PairingDialogContent data-hosted="true" data-v2="true">
				<PairingDialogHeader
					title="Pair Discord"
					identity={botIdentity}
					description="Install the app, then enter the one-time code."
				/>

				<PairingDialogBody data-discord-pair-dialog-body>
					{preparing ? (
						<PairingLoading>Creating a Discord pair code…</PairingLoading>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void prepare()}
							title="Couldn't prepare Discord pairing"
							normalizer={DISCORD_PAIR_ERROR_NORMALIZER}
						/>
					) : result ? (
						expired ? (
							<div className="space-y-4">
								<PairingNotice title="This Discord pair code has expired">
									Create a new code before pairing Discord.
								</PairingNotice>
								<PairingDialogActions className="sm:grid-cols-1">
									<Button
										className="w-full min-w-0 whitespace-normal"
										onClick={() => void prepare()}
									>
										<RefreshCw className="size-4" />
										Generate new code
									</Button>
								</PairingDialogActions>
							</div>
						) : (
							<div className="space-y-4">
								<Tabs
									value={path}
									onValueChange={(value) => {
										if (value === "server" || (value === "dm" && result.discord_user_install_url)) {
											setPath(value);
										}
									}}
								>
									<TabsList className="grid w-full grid-cols-2">
										<TabsTrigger value="server" className="px-1 text-xs sm:px-2 sm:text-sm">
											<Server className="size-3.5" />
											Server
										</TabsTrigger>
										<TabsTrigger
											value="dm"
											disabled={!result.discord_user_install_url}
											className="px-1 text-xs sm:px-2 sm:text-sm"
										>
											<MessageCircle className="size-3.5" />
											Direct message
										</TabsTrigger>
									</TabsList>

									<TabsContent
										value="server"
										data-discord-pair-path="server"
										className="mt-3 space-y-4"
									>
										{result.discord_install_url ? (
											<PairingQrCode
												value={result.discord_install_url}
												label="Discord server install QR code"
											/>
										) : (
											<>
												<PairingNotice
													title={
														result.server_install_retryable
															? "Server install temporarily unavailable"
															: "Server install unavailable"
													}
												>
													{result.server_install_retryable
														? "Direct message pairing is still available. Retry to request a new server install link."
														: "Use a server where this bot is already installed, or pair by direct message when available."}
												</PairingNotice>
												{result.server_install_retryable ? (
													<PairingDialogActions className="sm:grid-cols-1">
														<Button
															variant="outline"
															className="w-full min-w-0 whitespace-normal"
															onClick={() => void prepare()}
														>
															<RefreshCw className="size-4" />
															Retry server install
														</Button>
													</PairingDialogActions>
												) : null}
											</>
										)}
										<PairingExpiry>{pairCodeExpiryLabel(result.expires_at, nowMs)}</PairingExpiry>
										{result.discord_install_url ? (
											<PairingDialogActions>
												<Button
													render={
														<a
															href={result.discord_install_url}
															target="_blank"
															rel="noopener noreferrer"
														/>
													}
													nativeButton={false}
													className="w-full min-w-0 whitespace-normal"
												>
													Add to server
													<ExternalLink className="size-4" />
												</Button>
												<Button
													variant="outline"
													className="w-full min-w-0 whitespace-normal"
													onClick={() => {
														if (result.discord_install_url) {
															void copyInstallLink(result.discord_install_url);
														}
													}}
													aria-label={
														installLinkCopied
															? "Discord install link copied"
															: "Copy Discord install link"
													}
													aria-live="polite"
												>
													{installLinkCopied ? (
														<Check className="size-4" />
													) : (
														<Copy className="size-4" />
													)}
													{installLinkCopied ? "Link copied" : "Copy link"}
												</Button>
											</PairingDialogActions>
										) : null}
										{!result.discord_user_install_url ? (
											<PairingInstructionPanel role="status">
												<p className="text-sm font-medium">Direct message pairing unavailable</p>
												<p className="text-xs text-muted-foreground">Use Server pairing.</p>
											</PairingInstructionPanel>
										) : null}
										<PairingInstructionPanel>
											<p>
												{result.discord_install_url
													? "1. Add the bot to the server. You need Manage Server or Administrator."
													: "1. Open a server where this bot is already installed. You need Manage Server or Administrator."}
											</p>
											<div className="flex flex-wrap items-center gap-1.5">
												<span>2. In that server, run</span>
												<CopyablePairingCode
													value={result.pairing_command.split(" ", 1)[0]}
													label="Discord pairing command"
													variant="inline"
												/>
												<span>and paste this into the required code option:</span>
											</div>
											<CopyablePairingCode value={result.code} label="Discord pair code" />
										</PairingInstructionPanel>
									</TabsContent>

									{result.discord_user_install_url ? (
										<TabsContent value="dm" data-discord-pair-path="dm" className="mt-3 space-y-4">
											<PairingQrCode
												value={result.discord_user_install_url}
												label="Discord User Install QR code"
											/>
											<PairingExpiry>{pairCodeExpiryLabel(result.expires_at, nowMs)}</PairingExpiry>
											<PairingDialogActions>
												<Button
													render={
														<a
															href={result.discord_user_install_url}
															target="_blank"
															rel="noopener noreferrer"
														/>
													}
													nativeButton={false}
													className="w-full min-w-0 whitespace-normal"
												>
													Add to my apps
													<ExternalLink className="size-4" />
												</Button>
												<Button
													variant="outline"
													className="w-full min-w-0 whitespace-normal"
													onClick={() => {
														if (result.discord_user_install_url) {
															void copyInstallLink(result.discord_user_install_url);
														}
													}}
													aria-label={
														installLinkCopied
															? "Discord install link copied"
															: "Copy Discord install link"
													}
													aria-live="polite"
												>
													{installLinkCopied ? (
														<Check className="size-4" />
													) : (
														<Copy className="size-4" />
													)}
													{installLinkCopied ? "Link copied" : "Copy link"}
												</Button>
											</PairingDialogActions>
											<PairingInstructionPanel>
												<p>1. Install the app and choose Add to my apps in Discord.</p>
												<p>2. Open the app from Discord Direct Messages.</p>
												<div className="flex flex-wrap items-center gap-1.5">
													<span>3. Run</span>
													<CopyablePairingCode
														value={result.pairing_command.split(" ", 1)[0]}
														label="Discord pairing command"
														variant="inline"
													/>
													<span>and paste this into the required code option:</span>
												</div>
												<CopyablePairingCode value={result.code} label="Discord pair code" />
											</PairingInstructionPanel>
										</TabsContent>
									) : null}
								</Tabs>
							</div>
						)
					) : null}
				</PairingDialogBody>
			</PairingDialogContent>
		</Dialog>
	);
}
