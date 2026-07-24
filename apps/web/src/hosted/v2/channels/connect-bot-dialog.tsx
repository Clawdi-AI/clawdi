"use client";

import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	CHANNEL_PROVIDERS,
	type ChannelProviderId,
	PROVIDER_META,
} from "@/hosted/v2/channels/channel-providers";
import type { ChannelCreate, ChannelCreated } from "@/hosted/v2/channels/channel-types";
import { ProviderChip, TokenReveal } from "@/hosted/v2/channels/channel-ui";
import { useCreateChannel } from "@/hosted/v2/channels/channels-hooks";
import {
	discordApplicationIdError,
	discordBotTokenError,
	discordGuildIdError,
	discordPublicKeyError,
} from "@/hosted/v2/channels/connect-bot-dialog.logic";
import {
	channelDialogOpenChangeAllowed,
	WHATSAPP_LINKING_READY,
} from "@/hosted/v2/channels/link-agent-dialog.logic";

/**
 * Connect a channel. Each provider takes its OWN real inputs (grounded in
 * cloud-api): Telegram = bot token; Discord = bot token + application_id +
 * public_key (+ guild_id); WhatsApp = no token (agent/device linking is
 * gated during the beta). On success the
 * scoped agent token may be revealed once when an agent is auto-linked.
 */
export function ConnectBotDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const create = useCreateChannel();
	const [provider, setProvider] = useState<ChannelProviderId>("telegram");
	const [name, setName] = useState("");
	const [token, setToken] = useState(""); // Telegram / Discord bot token
	// Discord
	const [applicationId, setApplicationId] = useState("");
	const [publicKey, setPublicKey] = useState("");
	const [guildId, setGuildId] = useState("");
	const [created, setCreated] = useState<ChannelCreated | null>(null);
	const submitLocked = useRef(false);

	useEffect(() => {
		if (!open) return;
		setProvider("telegram");
		setName("");
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setGuildId("");
		setCreated(null);
	}, [open]);

	const meta = PROVIDER_META[provider];
	const discordSelected = meta.connect === "discord";
	const tokenError = discordSelected ? discordBotTokenError(token) : null;
	const applicationIdError = discordSelected ? discordApplicationIdError(applicationId) : null;
	const publicKeyError = discordSelected ? discordPublicKeyError(publicKey) : null;
	const guildIdError = discordSelected ? discordGuildIdError(guildId) : null;
	const isSubmitting = create.isPending || submitLocked.current;

	function changeProvider(next: ChannelProviderId) {
		if (next === "whatsapp" && !WHATSAPP_LINKING_READY) return;
		setProvider(next);
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setGuildId("");
	}

	const canSubmit =
		name.trim().length > 0 &&
		(meta.connect === "whatsapp"
			? WHATSAPP_LINKING_READY
			: meta.connect === "token"
				? token.trim().length > 0
				: meta.connect === "discord"
					? token.trim().length > 0 &&
						applicationId.trim().length > 0 &&
						!tokenError &&
						!applicationIdError &&
						!publicKeyError &&
						!guildIdError
					: false);

	function buildBody(): ChannelCreate | null {
		const trimmedName = name.trim();
		if (meta.connect === "discord") {
			const config: Record<string, unknown> = { application_id: applicationId.trim() };
			if (publicKey.trim()) config.public_key = publicKey.trim();
			if (guildId.trim()) config.guild_id = guildId.trim();
			return { provider, name: trimmedName, provider_token: token.trim(), config };
		}
		if (meta.connect === "token") {
			return { provider, name: trimmedName, provider_token: token.trim() };
		}
		if (!WHATSAPP_LINKING_READY) return null;
		return { provider, name: trimmedName };
	}

	function submit() {
		if (!canSubmit || submitLocked.current) return;
		const body = buildBody();
		if (!body) return;
		submitLocked.current = true;
		create.mutate(body, {
			onSuccess: (data) => setCreated(data),
			onSettled: () => {
				submitLocked.current = false;
			},
		});
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!channelDialogOpenChangeAllowed(nextOpen, create.isPending || submitLocked.current)) return;
		onOpenChange(nextOpen);
	}

	const discordVerificationPending = created?.provider === "discord";

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>
								{discordVerificationPending
									? "Discord setup saved — verification pending"
									: "Channel connected"}
							</DialogTitle>
							<DialogDescription>
								{discordVerificationPending ? (
									<>
										Credentials for <span className="font-medium">{created.name}</span> were saved,
										but Clawdi does not verify them with Discord during setup.
									</>
								) : (
									<>
										<span className="font-medium">{created.name}</span> is connected. Clawdi handles
										message delivery automatically.
									</>
								)}
							</DialogDescription>
						</DialogHeader>
						{discordVerificationPending ? (
							<div
								role="status"
								className="rounded-lg border border-warning/30 bg-warning-muted p-3 text-sm text-warning-muted-foreground"
							>
								<p className="font-medium">Verification pending</p>
								<p className="mt-1 text-xs">
									Send a test message to the bot, then review channel activity and health before
									relying on it.
								</p>
							</div>
						) : null}
						{created.agent_token ? (
							<TokenReveal
								label="Agent token"
								value={created.agent_token}
								note="An agent was auto-linked. This token lets it send and receive on the channel."
							/>
						) : null}
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => handleOpenChange(false)}
								disabled={isSubmitting}
							>
								Close
							</Button>
							<Button
								render={<Link to="/channels/$id" params={{ id: created.id }} />}
								nativeButton={false}
							>
								{discordVerificationPending ? "Open channel to verify" : "Open channel"}
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Connect a channel</DialogTitle>
							<DialogDescription>
								Each provider needs its own setup — pick one to see what it requires.
							</DialogDescription>
						</DialogHeader>

						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-1.5">
								<Label>Provider</Label>
								<div className="grid grid-cols-2 gap-2">
									{CHANNEL_PROVIDERS.map((p) => {
										const comingSoon = p === "whatsapp" && !WHATSAPP_LINKING_READY;
										return (
											<EntityChoiceCard
												key={p}
												selected={provider === p}
												onClick={() => changeProvider(p)}
												disabled={comingSoon}
												badge={
													comingSoon ? (
														<span className="text-xs text-muted-foreground">Coming soon</span>
													) : undefined
												}
												icon={
													<EntityIcon
														kind="channel"
														id={p}
														label={PROVIDER_META[p].label}
														size="sm"
													/>
												}
												title={PROVIDER_META[p].label}
												description={
													comingSoon ? "Hosted agent linking is not ready yet." : undefined
												}
											/>
										);
									})}
								</div>
							</div>

							<div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
								<ProviderChip provider={provider} />
								<p className="text-xs text-muted-foreground">{meta.hint}</p>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="connect-name">Name</Label>
								<Input
									id="connect-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Support Bot"
									autoComplete="off"
								/>
							</div>

							{/* Telegram / Discord bot token. */}
							{meta.connect !== "whatsapp" ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="connect-token">{meta.tokenLabel}</Label>
									<Input
										id="connect-token"
										type="password"
										value={token}
										onChange={(e) => setToken(e.target.value)}
										placeholder={meta.tokenPlaceholder}
										autoComplete="off"
										spellCheck={false}
										required
										aria-invalid={Boolean(tokenError)}
										aria-describedby={tokenError ? "connect-token-err" : undefined}
									/>
									{tokenError ? (
										<p id="connect-token-err" className="text-xs text-destructive">
											{tokenError}
										</p>
									) : null}
								</div>
							) : null}

							{/* Discord: application_id (+ public_key, guild_id). */}
							{meta.connect === "discord" ? (
								<>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="connect-app-id">Application ID</Label>
										<Input
											id="connect-app-id"
											value={applicationId}
											onChange={(e) => setApplicationId(e.target.value)}
											placeholder="Application (client) ID"
											autoComplete="off"
											spellCheck={false}
											required
											aria-invalid={Boolean(applicationIdError)}
											aria-describedby={
												applicationIdError ? "connect-app-id-err" : "connect-app-id-help"
											}
										/>
										{applicationIdError ? (
											<p id="connect-app-id-err" className="text-xs text-destructive">
												{applicationIdError}
											</p>
										) : (
											<p id="connect-app-id-help" className="text-xs text-muted-foreground">
												Required to publish slash commands.
											</p>
										)}
									</div>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="connect-public-key">
											Public key <span className="text-muted-foreground">· recommended</span>
										</Label>
										<Input
											id="connect-public-key"
											value={publicKey}
											onChange={(e) => setPublicKey(e.target.value)}
											placeholder="Ed25519 public key (hex)"
											autoComplete="off"
											spellCheck={false}
											aria-invalid={Boolean(publicKeyError)}
											aria-describedby={
												publicKeyError ? "connect-public-key-err" : "connect-public-key-help"
											}
										/>
										{publicKeyError ? (
											<p id="connect-public-key-err" className="text-xs text-destructive">
												{publicKeyError}
											</p>
										) : (
											<p id="connect-public-key-help" className="text-xs text-muted-foreground">
												Stored with the Discord application metadata.
											</p>
										)}
									</div>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="connect-guild-id">
											Guild ID <span className="text-muted-foreground">· optional</span>
										</Label>
										<Input
											id="connect-guild-id"
											value={guildId}
											onChange={(e) => setGuildId(e.target.value)}
											placeholder="Default command scope"
											autoComplete="off"
											spellCheck={false}
											aria-invalid={Boolean(guildIdError)}
											aria-describedby={guildIdError ? "connect-guild-id-err" : undefined}
										/>
										{guildIdError ? (
											<p id="connect-guild-id-err" className="text-xs text-destructive">
												{guildIdError}
											</p>
										) : null}
									</div>
								</>
							) : null}
						</div>

						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => handleOpenChange(false)}
								disabled={isSubmitting}
							>
								Cancel
							</Button>
							<Button onClick={submit} disabled={!canSubmit || isSubmitting}>
								{create.isPending ? "Connecting…" : "Connect"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
