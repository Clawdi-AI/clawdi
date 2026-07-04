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

/**
 * Connect a channel. Each provider takes its OWN real inputs (grounded in
 * cloud-api): Telegram = bot token; Discord = bot token + application_id +
 * public_key (+ guild_id); WhatsApp = no token (device is linked afterwards
 * via the Baileys tenant-creds flow on the channel page). On success the
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

	function changeProvider(next: ChannelProviderId) {
		setProvider(next);
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setGuildId("");
	}

	const canSubmit =
		name.trim().length > 0 &&
		(meta.connect === "whatsapp"
			? true
			: meta.connect === "token"
				? token.trim().length > 0
				: meta.connect === "discord"
					? token.trim().length > 0 && applicationId.trim().length > 0
					: false);

	function buildBody(): ChannelCreate {
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
		// whatsapp — no token; the device is linked afterwards (tenant-creds)
		return { provider, name: trimmedName };
	}

	function submit() {
		if (!canSubmit || submitLocked.current) return;
		submitLocked.current = true;
		create.mutate(buildBody(), {
			onSuccess: (data) => setCreated(data),
			onSettled: () => {
				submitLocked.current = false;
			},
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>Channel connected</DialogTitle>
							<DialogDescription>
								<span className="font-medium">{created.name}</span> is connected. Clawdi handles
								message delivery automatically. There is nothing else to configure.
							</DialogDescription>
						</DialogHeader>
						{created.agent_token ? (
							<TokenReveal
								label="Agent token"
								value={created.agent_token}
								note="An agent was auto-linked. This token lets it send and receive on the channel."
							/>
						) : null}
						{provider === "whatsapp" ? (
							<p className="text-sm text-muted-foreground">
								Next: open the channel and link your WhatsApp number under{" "}
								<span className="font-medium">Linked devices</span>.
							</p>
						) : null}
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Close
							</Button>
							<Button asChild>
								<Link to="/channels/$id" params={{ id: created.id }}>
									Open channel
								</Link>
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
									{CHANNEL_PROVIDERS.map((p) => (
										<EntityChoiceCard
											key={p}
											selected={provider === p}
											onClick={() => changeProvider(p)}
											icon={
												<EntityIcon
													kind="channel"
													id={p}
													label={PROVIDER_META[p].label}
													size="sm"
												/>
											}
											title={PROVIDER_META[p].label}
										/>
									))}
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
									/>
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
										/>
										<p className="text-xs text-muted-foreground">
											Required to publish slash commands.
										</p>
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
										/>
										<p className="text-xs text-muted-foreground">
											Stored with the Discord application metadata.
										</p>
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
										/>
									</div>
								</>
							) : null}
						</div>

						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button
								onClick={submit}
								disabled={!canSubmit || create.isPending || submitLocked.current}
							>
								{create.isPending ? "Connecting…" : "Connect"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
