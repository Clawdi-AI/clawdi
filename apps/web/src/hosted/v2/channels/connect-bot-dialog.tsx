"use client";

import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
	availableBotProvidersForAgent,
	CONNECTABLE_BOT_PROVIDERS,
	type ConnectableBotProvider,
} from "@/hosted/v2/channels/channel-linking.logic";
import { PROVIDER_META } from "@/hosted/v2/channels/channel-providers";
import type { ChannelCreate, ChannelCreated } from "@/hosted/v2/channels/channel-types";
import { useCreateChannel } from "@/hosted/v2/channels/channels-hooks";
import {
	discordApplicationIdError,
	discordBotTokenError,
	discordPublicKeyError,
} from "@/hosted/v2/channels/connect-bot-dialog.logic";

export function ConnectBotDialog({
	open,
	onOpenChange,
	agentId,
	agentType,
	linkedProviders,
	onAgentConnected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId?: string;
	agentType?: string;
	linkedProviders?: ReadonlySet<string>;
	onAgentConnected?: (bot: {
		id: string;
		name: string;
		provider: string;
		agentLinkId: string;
	}) => void;
}) {
	const create = useCreateChannel();
	const [provider, setProvider] = useState<ConnectableBotProvider>("telegram");
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [applicationId, setApplicationId] = useState("");
	const [publicKey, setPublicKey] = useState("");
	const [created, setCreated] = useState<Pick<
		ChannelCreated,
		"id" | "name" | "provider" | "agent_link_id" | "agent_id"
	> | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submitLocked = useRef(false);
	const openRef = useRef(open);
	const dialogSessionRef = useRef(0);
	openRef.current = open;
	const availableProviders = availableBotProvidersForAgent(agentId, agentType, linkedProviders);
	const unavailableProviders = CONNECTABLE_BOT_PROVIDERS.filter(
		(item) => !availableProviders.includes(item),
	);

	useEffect(() => {
		if (!open) return;
		setProvider(availableProviders[0] ?? "telegram");
		setName("");
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setCreated(null);
	}, [open, availableProviders[0]]);

	const meta = PROVIDER_META[provider];
	const providerAlreadyLinked = !availableProviders.includes(provider);
	const discordSelected = provider === "discord";
	const tokenError = discordSelected ? discordBotTokenError(token) : null;
	const applicationIdError = discordSelected ? discordApplicationIdError(applicationId) : null;
	const publicKeyError = discordSelected ? discordPublicKeyError(publicKey) : null;
	const isSubmitting = submitting || create.isPending;

	function changeProvider(next: ConnectableBotProvider) {
		if (!availableProviders.includes(next)) return;
		setProvider(next);
		setName("");
		setToken("");
		setApplicationId("");
		setPublicKey("");
	}

	const canSubmit =
		!providerAlreadyLinked &&
		name.trim().length > 0 &&
		token.trim().length > 0 &&
		(!discordSelected ||
			(applicationId.trim().length > 0 &&
				publicKey.trim().length > 0 &&
				!tokenError &&
				!applicationIdError &&
				!publicKeyError));

	function buildBody(): ChannelCreate {
		const base = {
			provider,
			name: name.trim(),
			provider_token: token.trim(),
			agent_id: agentId ?? null,
		};
		if (!discordSelected) return base;
		return {
			...base,
			config: {
				application_id: applicationId.trim(),
				public_key: publicKey.trim(),
			},
		};
	}

	async function submit() {
		if (!canSubmit || submitLocked.current) return;
		submitLocked.current = true;
		setSubmitting(true);
		const dialogSession = dialogSessionRef.current;
		try {
			const data = await create.execute(buildBody());
			setToken("");
			if (openRef.current && dialogSessionRef.current === dialogSession) {
				if (agentId && data.agent_link_id && onAgentConnected) {
					handleOpenChange(false);
					onAgentConnected({
						id: data.id,
						name: data.name,
						provider: data.provider,
						agentLinkId: data.agent_link_id,
					});
					return;
				}
				setCreated(data);
			} else {
				toast.success("Custom bot connected", {
					description: `${data.name} is ready to use.`,
				});
			}
		} catch {
			// useCreateChannel surfaces the API error; retain inputs for retry.
		} finally {
			submitLocked.current = false;
			setSubmitting(false);
		}
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			dialogSessionRef.current += 1;
			setToken("");
			setCreated(null);
		}
		onOpenChange(nextOpen);
	}

	const providerChoices = (
		<fieldset className="grid grid-cols-2 gap-2 border-0 p-0" aria-label="Provider">
			{CONNECTABLE_BOT_PROVIDERS.map((item) => {
				const alreadyLinked = !availableProviders.includes(item);
				return (
					<Button
						key={item}
						type="button"
						variant={!alreadyLinked && provider === item ? "secondary" : "outline"}
						className="h-12 min-w-0 justify-start gap-2 px-2.5"
						disabled={alreadyLinked}
						aria-pressed={!alreadyLinked && provider === item}
						onClick={() => changeProvider(item)}
					>
						<EntityIcon kind="channel" id={item} label={PROVIDER_META[item].label} size="sm" />
						<span className="min-w-0 truncate text-left leading-tight">
							{PROVIDER_META[item].label}
						</span>
					</Button>
				);
			})}
		</fieldset>
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-md [&>*]:min-w-0"
			>
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>Custom bot connected</DialogTitle>
							<DialogDescription>
								<span className="font-medium [overflow-wrap:anywhere]" title={created.name}>
									{created.name}
								</span>{" "}
								is ready to use.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button
								variant="outline"
								className="min-w-0 whitespace-normal"
								onClick={() => handleOpenChange(false)}
							>
								Done
							</Button>
							<Button
								render={<Link to="/channels/$id" params={{ id: created.id }} />}
								nativeButton={false}
								className="min-w-0 whitespace-normal"
							>
								View Custom bot
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Connect custom bot</DialogTitle>
							<DialogDescription>
								{agentId
									? "Connect a Custom bot you manage to this Agent."
									: "Connect a Custom bot you manage."}
							</DialogDescription>
						</DialogHeader>

						{availableProviders.length === 0 ? (
							<div className="space-y-3">
								{providerChoices}
								<p role="status" className="text-sm text-muted-foreground">
									This Agent already has a channel from each provider. Unlink one before connecting
									a Custom bot.
								</p>
							</div>
						) : (
							<div className="flex flex-col gap-3">
								{providerChoices}
								{unavailableProviders.length === 1 ? (
									<p className="text-xs text-muted-foreground">
										{PROVIDER_META[unavailableProviders[0]].label} is already linked to this Agent.
										Unlink it to connect another Custom bot from that provider.
									</p>
								) : null}
								<p className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
									{provider === "telegram" ? "Need a bot token? " : "Need app credentials? "}
									<a
										href={meta.setupUrl}
										target="_blank"
										rel="noreferrer"
										className="inline-flex min-w-0 flex-wrap items-center gap-1 font-medium text-foreground underline underline-offset-4"
									>
										{provider === "telegram"
											? "Create a bot with @BotFather"
											: "Open Discord Developer Portal"}
										<ExternalLink className="size-3" />
									</a>
								</p>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="connect-name">Name</Label>
									<Input
										id="connect-name"
										value={name}
										onChange={(event) => setName(event.target.value)}
										placeholder="Support Bot"
										autoComplete="off"
									/>
								</div>

								<div className="flex flex-col gap-1.5">
									<Label htmlFor="connect-token">Bot token</Label>
									<Input
										id="connect-token"
										type="password"
										value={token}
										onChange={(event) => setToken(event.target.value)}
										placeholder={meta.tokenPlaceholder}
										autoComplete="off"
										spellCheck={false}
										required
										aria-invalid={Boolean(tokenError)}
										aria-describedby={tokenError ? "connect-token-error" : undefined}
									/>
									{tokenError ? (
										<p
											id="connect-token-error"
											className="break-words text-xs text-destructive [overflow-wrap:anywhere]"
										>
											{tokenError}
										</p>
									) : null}
								</div>

								{discordSelected ? (
									<>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="connect-app-id">Application ID</Label>
											<Input
												id="connect-app-id"
												value={applicationId}
												onChange={(event) => setApplicationId(event.target.value)}
												placeholder="Application ID"
												autoComplete="off"
												spellCheck={false}
												required
												aria-invalid={Boolean(applicationIdError)}
												aria-describedby={applicationIdError ? "connect-app-id-error" : undefined}
											/>
											{applicationIdError ? (
												<p
													id="connect-app-id-error"
													className="break-words text-xs text-destructive [overflow-wrap:anywhere]"
												>
													{applicationIdError}
												</p>
											) : null}
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="connect-public-key">Public key</Label>
											<Input
												id="connect-public-key"
												value={publicKey}
												onChange={(event) => setPublicKey(event.target.value)}
												placeholder="64-character hex public key"
												autoComplete="off"
												spellCheck={false}
												required
												aria-invalid={Boolean(publicKeyError)}
												aria-describedby={publicKeyError ? "connect-public-key-error" : undefined}
											/>
											{publicKeyError ? (
												<p
													id="connect-public-key-error"
													className="break-words text-xs text-destructive [overflow-wrap:anywhere]"
												>
													{publicKeyError}
												</p>
											) : null}
										</div>
									</>
								) : null}
							</div>
						)}

						<DialogFooter>
							<Button
								variant="outline"
								className="min-w-0 whitespace-normal"
								onClick={() => handleOpenChange(false)}
							>
								{isSubmitting ? "Close" : "Cancel"}
							</Button>
							{availableProviders.length > 0 ? (
								<Button
									className="min-w-0 whitespace-normal"
									onClick={() => void submit()}
									disabled={!canSubmit || isSubmitting}
								>
									{isSubmitting ? "Connecting…" : "Connect custom bot"}
								</Button>
							) : null}
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
