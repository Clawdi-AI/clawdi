"use client";

import { ExternalLink, MessageCircle, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pairCodeExpiryLabel } from "@/hosted/v2/channels/channel-detail-page.logic";
import {
	pairCodeExpired,
	verifiedDiscordPairingCommand,
	verifiedDiscordUserInstallUrl,
} from "@/hosted/v2/channels/channel-linking.logic";
import { usePairingSuccess } from "@/hosted/v2/channels/channel-pairing-success";
import type { ChannelBinding, ChannelPairCode } from "@/hosted/v2/channels/channel-types";
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

const DISCORD_PAIR_TTL_SECONDS = 900;

type DiscordPairResult = Pick<
	ChannelPairCode,
	"code" | "expires_at" | "pairing_command" | "discord_install_url" | "discord_user_install_url"
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
	const [result, setResult] = useState<DiscordPairResult | null>(null);
	const [requestError, setRequestError] = useState<unknown>(null);
	const [preparing, setPreparing] = useState(false);
	const [path, setPath] = useState<"server" | "dm">("server");
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
					throw new Error("Discord pairing instructions are out of date. Refresh and try again.");
				}
				setNowMs(Date.now());
				setResult({
					code: data.code,
					expires_at: data.expires_at,
					pairing_command: pairingCommand,
					discord_install_url: data.discord_install_url,
					discord_user_install_url: verifiedDiscordUserInstallUrl(data.discord_user_install_url),
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
			setPath("server");
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
	const installAction =
		result && path === "server" && result.discord_install_url
			? { url: result.discord_install_url, label: "Add to server" }
			: result && path === "dm" && result.discord_user_install_url
				? { url: result.discord_user_install_url, label: "Add to my apps" }
				: null;

	return (
		<Dialog open={open} onOpenChange={handlePairingOpenChange}>
			<PairingDialogContent>
				<PairingDialogHeader
					title="Pair Discord"
					identity={botIdentity}
					description="Choose a server or direct message to pair."
				/>

				<PairingDialogBody data-discord-pair-dialog-body>
					{preparing ? (
						<PairingLoading>Creating a Discord pair code…</PairingLoading>
					) : requestError ? (
						<ApiErrorPanel
							error={requestError}
							onRetry={() => void prepare()}
							title="Couldn't prepare Discord pairing"
						/>
					) : result ? (
						expired ? (
							<PairingNotice title="This Discord pair code has expired">
								Create a new code before pairing Discord.
							</PairingNotice>
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
											<PairingNotice title="Server install unavailable">
												Use a server where this bot is already installed, or ask the bot owner for a
												valid server install link.
											</PairingNotice>
										)}
										<PairingExpiry>{pairCodeExpiryLabel(result.expires_at, nowMs)}</PairingExpiry>
										{!result.discord_user_install_url ? (
											<PairingInstructionPanel role="status">
												<p className="text-sm font-medium">Direct message pairing unavailable</p>
												<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
													<span>
														Use Server pairing. The bot owner can enable Discord User Install with
														the
													</span>
													<CopyablePairingCode
														value="applications.commands"
														label="Discord application commands scope"
														variant="inline"
													/>
													<span>scope to add direct message pairing.</span>
												</div>
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
											<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
												<span>
													If Discord rejects the install, ask the bot owner to enable User Install
													with
												</span>
												<CopyablePairingCode
													value="applications.commands"
													label="Discord application commands scope"
													variant="inline"
												/>
												<span>in the Discord Developer Portal.</span>
											</div>
										</TabsContent>
									) : null}
								</Tabs>
							</div>
						)
					) : null}
				</PairingDialogBody>

				{result && !expired && installAction ? (
					<PairingDialogFooter>
						<Button
							render={<a href={installAction.url} target="_blank" rel="noopener noreferrer" />}
							nativeButton={false}
							className="w-full min-w-0 whitespace-normal sm:w-auto"
						>
							{installAction.label}
							<ExternalLink className="size-4" />
						</Button>
					</PairingDialogFooter>
				) : result && expired ? (
					<PairingDialogFooter>
						<Button
							className="w-full min-w-0 whitespace-normal sm:w-auto"
							onClick={() => void prepare()}
						>
							<RefreshCw className="size-4" />
							Generate new code
						</Button>
					</PairingDialogFooter>
				) : null}
			</PairingDialogContent>
		</Dialog>
	);
}
