"use client";

import { Link } from "@tanstack/react-router";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EntityIcon } from "@/components/entity-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
	agentProviderHasSingleLinkLimit,
	autoLinkAgentIdForNewCustomBot,
	CONNECTABLE_BOT_PROVIDERS,
	type ConnectableBotProvider,
} from "@/hosted/v2/channels/channel-linking.logic";
import { PROVIDER_META, providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelCreate, ChannelCreated } from "@/hosted/v2/channels/channel-types";
import { useCreateChannel } from "@/hosted/v2/channels/channels-hooks";
import {
	discordApplicationIdError,
	discordBotTokenError,
	discordPublicKeyError,
} from "@/hosted/v2/channels/connect-bot-dialog.logic";
import { WhatsAppDeviceOnboarding } from "@/hosted/v2/channels/whatsapp-device-onboarding";
import { type AgentRouteQuery, agentSectionLink } from "@/lib/agent-routes";

type CreatedCustomBot = Pick<
	ChannelCreated,
	"id" | "name" | "provider" | "agent_link_id" | "agent_id"
> & {
	linkOutcome: "linked" | "inventory-only" | "inventory-only-provider-conflict";
};

export function ConnectBotDialog({
	open,
	onOpenChange,
	agentId,
	agentType,
	linkedProviders,
	agentRouteQuery,
	onAgentConnected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agentId?: string;
	agentType?: string;
	linkedProviders?: ReadonlySet<string>;
	agentRouteQuery?: AgentRouteQuery;
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
	const [created, setCreated] = useState<CreatedCustomBot | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submitLocked = useRef(false);
	const openRef = useRef(open);
	const dialogSessionRef = useRef(0);
	openRef.current = open;

	useEffect(() => {
		if (!open) return;
		setProvider("telegram");
		setName("");
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setCreated(null);
	}, [open]);

	const meta = PROVIDER_META[provider];
	const discordSelected = provider === "discord";
	const whatsappSelected = provider === "whatsapp";
	const providerLinkConflict = Boolean(
		agentId &&
			agentProviderHasSingleLinkLimit(agentType, provider) &&
			linkedProviders?.has(provider),
	);
	const agentLinkStatusUnknown = Boolean(
		agentId && agentProviderHasSingleLinkLimit(agentType, provider) && !linkedProviders,
	);
	const autoLinkAgentId = autoLinkAgentIdForNewCustomBot(
		agentId,
		agentType,
		provider,
		linkedProviders,
	);
	const tokenError = discordSelected ? discordBotTokenError(token) : null;
	const applicationIdError = discordSelected ? discordApplicationIdError(applicationId) : null;
	const publicKeyError = discordSelected ? discordPublicKeyError(publicKey) : null;
	const isSubmitting = submitting || create.isPending;
	const agentLinkWarning =
		!whatsappSelected && providerLinkConflict
			? {
					title: "Won’t link automatically",
					description: `This Agent already has a ${meta.label} bot. The new Custom bot will be added to Custom bots without being linked to this Agent.`,
				}
			: !whatsappSelected && agentLinkStatusUnknown
				? {
						title: "Agent link status unavailable",
						description:
							"Clawdi can’t confirm this Agent’s existing links right now. The new Custom bot will be added to Custom bots without being linked to this Agent.",
					}
				: null;

	function changeProvider(next: ConnectableBotProvider) {
		if (isSubmitting) return;
		setProvider(next);
		setName("");
		setToken("");
		setApplicationId("");
		setPublicKey("");
	}

	const canSubmit =
		!whatsappSelected &&
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
			agent_id: autoLinkAgentId,
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
		const body = buildBody();
		const skippedLinkForProviderConflict = providerLinkConflict;
		try {
			const data = await create.execute(body);
			const result: CreatedCustomBot = {
				...data,
				linkOutcome: data.agent_link_id
					? "linked"
					: skippedLinkForProviderConflict
						? "inventory-only-provider-conflict"
						: "inventory-only",
			};
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
				setCreated(result);
			} else {
				toast.success(result.linkOutcome === "linked" ? "Custom bot linked" : "Custom bot added", {
					description:
						result.linkOutcome === "linked"
							? `${data.name} was added and linked to this Agent.`
							: agentId
								? `${data.name} was added to Custom bots without linking to this Agent.`
								: `${data.name} was added to Custom bots.`,
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
		}
		onOpenChange(nextOpen);
	}

	function handleOpenChangeComplete(nextOpen: boolean) {
		if (!nextOpen) setCreated(null);
	}

	const providerChoices = (
		<fieldset className="grid grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-3" aria-label="Provider">
			{CONNECTABLE_BOT_PROVIDERS.map((item) => {
				return (
					<Button
						key={item}
						type="button"
						variant={provider === item ? "secondary" : "outline"}
						className="h-auto min-h-12 min-w-0 justify-start gap-1.5 px-2 sm:gap-2 sm:px-2.5"
						disabled={isSubmitting}
						aria-pressed={provider === item}
						onClick={() => changeProvider(item)}
					>
						<EntityIcon kind="channel" id={item} label={PROVIDER_META[item].label} size="sm" />
						<span className="min-w-0 whitespace-normal break-words text-left text-xs leading-tight [overflow-wrap:anywhere] sm:text-sm">
							{PROVIDER_META[item].label}
						</span>
					</Button>
				);
			})}
		</fieldset>
	);
	const otherProviderHint = (
		<p
			data-other-provider-hint
			className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]"
		>
			Need a provider that Clawdi Channels doesn&apos;t support?{" "}
			{agentId ? (
				<>
					Configure it in this Agent&apos;s{" "}
					<Link
						{...agentSectionLink(agentId, "console", agentRouteQuery)}
						className="font-medium text-foreground underline underline-offset-4"
						onClick={() => handleOpenChange(false)}
					>
						Agent Interface
					</Link>
					.
				</>
			) : (
				"Open the relevant Agent's Agent Interface to configure it."
			)}
		</p>
	);

	return (
		<Dialog
			open={open}
			onOpenChange={handleOpenChange}
			onOpenChangeComplete={handleOpenChangeComplete}
		>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-md [&>*]:min-w-0"
			>
				{created ? (
					<>
						<DialogHeader>
							<DialogTitle>
								{created.linkOutcome === "linked" ? "Custom bot linked" : "Custom bot added"}
							</DialogTitle>
							<DialogDescription>
								<span className="font-medium [overflow-wrap:anywhere]" title={created.name}>
									{created.name}
								</span>{" "}
								{created.linkOutcome === "linked"
									? "was added to Custom bots and linked to this Agent."
									: created.linkOutcome === "inventory-only-provider-conflict"
										? `was added to Custom bots. It was not linked because this Agent already has a ${providerMeta(created.provider).label} bot.`
										: agentId
											? "was added to Custom bots without linking to this Agent."
											: "was added to Custom bots. Link it from an Agent when you’re ready."}
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
							<DialogTitle>Add channel</DialogTitle>
							<DialogDescription>
								{agentId
									? "Add a Custom bot you manage. When possible, it will be linked to this Agent automatically."
									: "Add a Custom bot you manage to your inventory."}
							</DialogDescription>
						</DialogHeader>

						<div className="flex min-w-0 flex-col gap-3">
							{providerChoices}
							{otherProviderHint}
							{agentLinkWarning ? (
								<Alert
									data-agent-link-warning
									className="border-warning/30 bg-warning-muted py-2.5"
								>
									<TriangleAlert aria-hidden />
									<AlertTitle>{agentLinkWarning.title}</AlertTitle>
									<AlertDescription className="text-xs">
										{agentLinkWarning.description}
									</AlertDescription>
								</Alert>
							) : !whatsappSelected && agentId ? (
								<p role="status" className="text-xs text-muted-foreground" aria-live="polite">
									The new Custom bot will be linked to this Agent automatically.
								</p>
							) : null}
							{whatsappSelected ? (
								<WhatsAppDeviceOnboarding onDone={() => handleOpenChange(false)} />
							) : (
								<>
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
								</>
							)}
						</div>

						{!whatsappSelected ? (
							<DialogFooter>
								<Button
									variant="outline"
									className="min-w-0 whitespace-normal"
									onClick={() => handleOpenChange(false)}
								>
									{isSubmitting ? "Close" : "Cancel"}
								</Button>
								<Button
									className="min-w-0 whitespace-normal"
									onClick={() => void submit()}
									disabled={!canSubmit || isSubmitting}
								>
									{isSubmitting ? "Adding…" : "Add custom bot"}
								</Button>
							</DialogFooter>
						) : null}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
