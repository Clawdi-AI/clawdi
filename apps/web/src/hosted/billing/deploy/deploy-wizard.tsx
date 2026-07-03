"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import { useRouter } from "@tanstack/react-router";
import {
	CalendarClock,
	Check,
	ChevronsUpDown,
	Cpu,
	Plus,
	Rocket,
	Sparkles,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { BillingError } from "@/hosted/billing/components/state-views";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type { BillingOffer, DeployRequest, Plan } from "@/hosted/billing/contracts";
import { usesActiveFreeComputeSlot } from "@/hosted/billing/deploy/deploy-model";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import {
	useCheckout,
	useCreateDeployment,
	useHostedDeployments,
	usePlans,
} from "@/hosted/billing/hooks";
import { planOffers, selectOfferForTerm } from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { useAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	aiProviderRuntimeId,
	buildAiProviderBootstrap,
	type RuntimeAiProviderAuthKind,
} from "@/hosted/v2/ai-providers/runtime-bootstrap";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/v2/channels/channel-types";
import { useChannels } from "@/hosted/v2/channels/channels-hooks";
import { ConnectBotDialog } from "@/hosted/v2/channels/connect-bot-dialog";
import { agentSectionHref } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

type Compute = "free" | "performance";
type Engine = "openclaw" | "hermes";
type ComputePlanSlug = DeployRequest["compute_plan_slug"];
const DEPLOY_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.detail, "flex flex-col gap-6 px-4 lg:px-6");
const THREE_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3";
const TWO_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";

/** Personality presets accepted by hosted deployment onboarding. */
const PERSONALITY_PRESETS = [
	{ id: "friendly", label: "Friendly" },
	{ id: "professional", label: "Professional" },
	{ id: "creative", label: "Creative" },
	{ id: "concise", label: "Concise" },
] as const;

/** Common UI languages offered during onboarding. */
const LANGUAGE_OPTIONS = [
	{ code: "en", label: "English" },
	{ code: "zh-CN", label: "简体中文" },
	{ code: "zh-TW", label: "繁體中文" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "es", label: "Español" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" },
	{ code: "pt", label: "Português" },
];

function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		return "";
	}
}

function supportedTimezones(): string[] {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
}

function activePlan(plans: Plan[] | undefined, paid: boolean): Plan | undefined {
	return plans?.find((p) => (paid ? p.price_cents > 0 : p.price_cents === 0));
}

function aiAuthKind(provider: AiProvider): RuntimeAiProviderAuthKind {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}

/** Deploy-wizard option — the family's selectable-choice card. */
function Tile({
	selected,
	onClick,
	leading,
	title,
	subtitle,
	badge,
	disabled,
}: {
	selected: boolean;
	onClick?: () => void;
	leading: React.ReactNode;
	title: string;
	subtitle: string;
	badge?: React.ReactNode;
	disabled?: boolean;
}) {
	return (
		<EntityChoiceCard
			selected={selected}
			onClick={onClick}
			icon={leading}
			title={title}
			description={subtitle}
			badge={badge}
			disabled={disabled}
		/>
	);
}

/** Tinted chip for abstract options (managed AI, attach-later, compute tiers) —
 * matches EntityIcon md geometry so it sits flush with the brand icons. */
function IconChip({ tint, children }: { tint: string; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex size-10 shrink-0 items-center justify-center rounded-lg [&>svg]:size-5",
				tint,
			)}
			aria-hidden="true"
		>
			{children}
		</span>
	);
}

function AddTile({
	title,
	description,
	onClick,
}: {
	title: string;
	description: string;
	onClick: () => void;
}) {
	return (
		<EntityChoiceCard
			selected={false}
			onClick={onClick}
			icon={
				<IconChip tint="bg-muted text-muted-foreground">
					<Plus />
				</IconChip>
			}
			title={title}
			description={description}
			className="h-full border-dashed bg-card"
		/>
	);
}

function ChannelInfoTile({ channel }: { channel: ChannelAccount }) {
	const meta = providerMeta(channel.provider);
	return (
		<EntityChoiceCard
			selected={false}
			icon={<EntityIcon kind="channel" id={channel.provider} label={meta.label} />}
			title={channel.name}
			description={`${meta.label} is ready. Link it from the agent page after deploy.`}
			badge={
				<Badge variant="outline" className="capitalize">
					{channel.status}
				</Badge>
			}
			className="h-full bg-card"
		/>
	);
}

function timezoneLabel(timezone: string): string {
	return timezone.replaceAll("_", " ");
}

function TimezoneCombobox({
	value,
	onValueChange,
	options,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: string[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id="agent-timezone"
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="w-full justify-between"
				>
					<span className={cn("truncate", !value && "text-muted-foreground")}>
						{value ? timezoneLabel(value) : "Select a timezone"}
					</span>
					<ChevronsUpDown className="opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
				<Command>
					<CommandInput placeholder="Search timezones…" />
					<CommandList className="max-h-72">
						<CommandEmpty>No timezone found.</CommandEmpty>
						<CommandGroup>
							{options.map((tz) => {
								const selected = value === tz;
								return (
									<CommandItem
										key={tz}
										value={tz}
										keywords={[timezoneLabel(tz), tz.replaceAll("/", " ")]}
										onSelect={() => {
											onValueChange(tz);
											setOpen(false);
										}}
									>
										<Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
										<span className="truncate">{timezoneLabel(tz)}</span>
										{timezoneLabel(tz) !== tz ? (
											<span className="ml-auto truncate text-xs text-muted-foreground">{tz}</span>
										) : null}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

interface ComputeStatusInput {
	compute: Compute;
	freeSlotPending: boolean;
	freeSlotUsed: boolean;
	deploymentsError: unknown;
	freePlan: Plan | undefined;
	perfOffer: BillingOffer | null;
}

function ComputeStatusLine(input: ComputeStatusInput) {
	const status = computeStatusLine(input);
	if (!status) return null;
	return (
		<p
			className={cn(
				"text-xs",
				status.tone === "destructive" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{status.message}
		</p>
	);
}

function computeStatusLine({
	compute,
	freeSlotPending,
	freeSlotUsed,
	deploymentsError,
	freePlan,
	perfOffer,
}: ComputeStatusInput): { message: string; tone: "destructive" | "muted" } | null {
	if (compute === "free") {
		if (deploymentsError) {
			return {
				tone: "destructive",
				message: "Couldn’t verify your Free slot. Retry this page before deploying Free.",
			};
		}
		if (!freePlan) {
			return {
				tone: "destructive",
				message:
					"Free compute isn’t available from the billing service. Retry plans before deploying.",
			};
		}
		if (freeSlotUsed) {
			return {
				tone: "muted",
				message:
					"You already have an active Free agent. Stop or delete it to reuse Free, or deploy a Performance agent.",
			};
		}
		if (freeSlotPending) {
			return {
				tone: "muted",
				message: "Checking whether your Free slot is available before deployment.",
			};
		}
		return null;
	}

	if (perfOffer && perfOffer.billing_term_months !== 1) {
		return {
			tone: "muted",
			message: `You’ll be sent to checkout. Billed ${formatCentsCompact(
				perfOffer.price_cents,
			)}${billingTermSuffix(
				perfOffer.billing_term_months,
			)}; each Performance agent uses its own subscription.`,
		};
	}
	return {
		tone: "muted",
		message: "You’ll be sent to checkout. Each Performance agent uses its own subscription.",
	};
}

export function DeployWizard() {
	const router = useRouter();
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const aiProviders = useAiProviders();
	const channels = useChannels();
	const createDeployment = useCreateDeployment();
	const checkout = useCheckout();
	const runAction = useActionLock();

	const [engines, setEngines] = useState<Record<Engine, boolean>>({
		openclaw: true,
		hermes: false,
	});
	const [aiChoice, setAiChoice] = useState<string>("managed"); // "managed" | provider_id
	const [compute, setCompute] = useState<Compute>("free");
	const [agentName, setAgentName] = useState("");
	const [personality, setPersonality] = useState("");
	const [language, setLanguage] = useState("");
	const [timezone, setTimezone] = useState("");
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [connectChannelOpen, setConnectChannelOpen] = useState(false);
	const [term, setTerm] = useState(1);
	const [submitting, setSubmitting] = useState(false);

	// Default the timezone to the browser's after mount (avoids an SSR mismatch).
	useEffect(() => {
		setTimezone((tz) => tz || browserTimezone());
	}, []);
	const tzOptions = useMemo(() => {
		const all = supportedTimezones();
		if (timezone && !all.includes(timezone)) return [timezone, ...all];
		return all;
	}, [timezone]);

	const freePlan = activePlan(plans.data, false);
	const perfPlan = activePlan(plans.data, true);
	const freeSlotUsed = usesActiveFreeComputeSlot(deployments.data);
	const freeSlotPending = deployments.isLoading;
	const freeSlotUnavailable = freeSlotUsed || freeSlotPending || !!deployments.error;

	const dualAllowed = compute === "performance";
	const enginesSelected = (Object.keys(engines) as Engine[]).filter((e) => engines[e]);
	const providerList = useMemo(
		() =>
			(aiProviders.data?.providers ?? []).filter(
				(provider) => !isFirstPartyManagedAiProvider(provider),
			),
		[aiProviders.data?.providers],
	);
	const channelList = channels.data ?? [];
	const computePlanReady =
		compute === "performance" ? !!perfPlan : !!freePlan && !freeSlotUnavailable;
	const planReady = !plans.isLoading && computePlanReady;
	const canSubmit = planReady && !submitting;

	useEffect(() => {
		if (compute !== "performance" || !plans.isSuccess || perfPlan) return;
		setCompute("free");
		setEngines((prev) => (prev.openclaw && prev.hermes ? { openclaw: true, hermes: false } : prev));
	}, [compute, plans.isSuccess, perfPlan]);

	// Don't let the selection silently degrade to managed: if the chosen
	// provider vanishes from a SUCCESSFULLY-loaded list (deleted elsewhere),
	// reset to managed so the UI and the deploy request agree.
	useEffect(() => {
		if (
			aiChoice !== "managed" &&
			aiProviders.isSuccess &&
			!providerList.some((p) => p.provider_id === aiChoice)
		) {
			setAiChoice("managed");
		}
	}, [aiChoice, aiProviders.isSuccess, providerList]);

	useEffect(() => {
		if (compute !== "free" || !freeSlotUsed || !perfPlan) return;
		setCompute("performance");
	}, [compute, freeSlotUsed, perfPlan]);

	const perfOffer = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, term) : null),
		[perfPlan, term],
	);
	const perfOffers = perfPlan ? planOffers(perfPlan) : [];

	function toggleEngine(engine: Engine) {
		setEngines((prev) => {
			if (dualAllowed) {
				return { ...prev, [engine]: !prev[engine] };
			}
			if (prev[engine]) return { ...prev, [engine]: false };
			return { openclaw: engine === "openclaw", hermes: engine === "hermes" };
		});
	}

	function setComputeTier(next: Compute) {
		setCompute(next);
		if (next === "free" && engines.openclaw && engines.hermes) {
			setEngines({ openclaw: true, hermes: false });
		}
	}

	function providerUnavailable(description = "Refresh providers or choose Managed by Clawdi.") {
		toast.error("Provider unavailable", { description });
	}

	function aiDeployFields(): Partial<DeployRequest> | null {
		if (aiChoice === "managed") return { ai_provider_auth_kind: "managed" };
		const provider = providerList.find((p) => p.provider_id === aiChoice);
		if (!provider) {
			providerUnavailable();
			return null;
		}
		const kind = aiAuthKind(provider);
		try {
			const providerRef = aiProviderRuntimeId(provider);
			return {
				ai_provider_id: providerRef,
				ai_provider_auth_kind: kind,
				ai_provider_bootstrap: buildAiProviderBootstrap(provider, kind),
			};
		} catch (error) {
			providerUnavailable(error instanceof Error ? error.message : "Check provider configuration.");
			return null;
		}
	}

	function buildDeployRequest(aiFields: Partial<DeployRequest>): DeployRequest {
		const computePlanSlug: ComputePlanSlug =
			compute === "performance" ? "compute_performance" : "compute_free";
		return buildHostedDeployRequest({
			computePlanSlug,
			engines,
			persona: {
				assistantName: agentName,
				personality,
				language,
				timezone,
			},
			aiFields,
		});
	}

	function redirectTo(url: string | null | undefined): boolean {
		if (url) {
			window.location.href = url;
			return true;
		}
		return false;
	}

	async function onDeploy() {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			const aiFields = aiDeployFields();
			if (!aiFields) return;
			const deployConfig = buildDeployRequest(aiFields);

			if (compute === "performance" && perfPlan) {
				const result = await checkout.mutateAsync({
					plan_slug: perfPlan.slug,
					billing_term_months: term,
					ui_mode: "hosted",
					deploy_config: deployConfig,
				});
				if (redirectTo(result.action_url || result.checkout_url)) return;
				toast.error("Couldn't start checkout", {
					description: "No checkout URL was returned. Please try again.",
				});
				return;
			}

			const deployment = await createDeployment.mutateAsync(deployConfig);
			toast.success("Deploying your agent", {
				description: "It’ll appear in your agents in a moment.",
			});
			void router.navigate({
				href: agentSectionHref(deployment.id, "overview", "source=on-clawdi"),
			});
		} catch (e) {
			toast.error("Couldn’t deploy", { description: normalizeBillingError(e) });
		} finally {
			setSubmitting(false);
		}
	}

	const deployLabel = compute === "performance" ? "Continue to checkout" : "Deploy agent";
	const aiSummary =
		aiChoice === "managed"
			? "Managed AI"
			: (providerList.find((p) => p.provider_id === aiChoice)?.label ?? "Your provider");
	const runtimeSummary =
		enginesSelected.length === 2
			? "Codex + OpenClaw + Hermes"
			: enginesSelected[0] === "openclaw"
				? "Codex + OpenClaw"
				: enginesSelected[0] === "hermes"
					? "Codex + Hermes"
					: "Codex";
	const personalityLabel = PERSONALITY_PRESETS.find((p) => p.id === personality)?.label;
	const summaryLine = [
		agentName.trim() || null,
		`${compute === "performance" ? "Performance" : "Free"} compute`,
		aiSummary,
		runtimeSummary,
		personalityLabel ?? null,
		LANGUAGE_OPTIONS.find((l) => l.code === language)?.label ?? null,
		timezone || null,
	]
		.filter(Boolean)
		.join(" · ");

	if (plans.error) {
		return (
			<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
				<PageHeader title="Deploy an agent" />
				<BillingError error={plans.error} onRetry={() => plans.refetch()} />
			</div>
		);
	}

	if (plans.isLoading) {
		return (
			<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
				<PageHeader title="Deploy an agent" description="Preparing your compute options…" />
				<Skeleton className="h-32 w-full rounded-lg" />
				<Skeleton className="h-32 w-full rounded-lg" />
				<Skeleton className="h-40 w-full rounded-lg" />
			</div>
		);
	}

	return (
		<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
			<PageHeader
				title="Deploy an agent"
				description="Codex is included by default. Add optional runtimes and choose the AI provider for this hosted deployment."
			/>

			{/* 1. Runtime */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">1. Hosted runtimes</CardTitle>
					<CardDescription>
						{dualAllowed
							? "Codex stays on. Performance can also run OpenClaw and Hermes together."
							: "Codex stays on. Free can add one optional runtime."}
					</CardDescription>
				</CardHeader>
				<CardContent className={THREE_TILE_GRID_CLASS}>
					<Tile
						selected
						leading={<EntityIcon kind="framework" id="codex" label="Codex" />}
						title="Codex"
						subtitle="Default hosted coding runtime."
						badge={<Badge variant="outline">Always on</Badge>}
					/>
					<Tile
						selected={engines.openclaw}
						onClick={() => toggleEngine("openclaw")}
						leading={<EntityIcon kind="framework" id="openclaw" label="OpenClaw" />}
						title="OpenClaw"
						subtitle="General-purpose agent runtime."
					/>
					<Tile
						selected={engines.hermes}
						onClick={() => toggleEngine("hermes")}
						leading={<EntityIcon kind="framework" id="hermes" label="Hermes" />}
						title="Hermes"
						subtitle="Messaging-first agent runtime."
					/>
				</CardContent>
			</Card>

			{/* 2. AI provider — mandatory, reuses /ai-providers */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">2. AI provider</CardTitle>
					<CardDescription>
						Managed AI bills your wallet, or route through one of your own providers.
					</CardDescription>
				</CardHeader>
				<CardContent className={TWO_TILE_GRID_CLASS}>
					<Tile
						selected={aiChoice === "managed"}
						onClick={() => setAiChoice("managed")}
						leading={
							<IconChip tint="bg-primary/10 text-primary">
								<Sparkles />
							</IconChip>
						}
						title="Managed by Clawdi"
						subtitle="AI Credits from your wallet."
						badge={<Badge variant="secondary">Default</Badge>}
					/>
					{aiProviders.isLoading ? (
						<Skeleton className="h-[74px] w-full rounded-lg" />
					) : aiProviders.error ? (
						<button
							type="button"
							onClick={() => aiProviders.refetch()}
							className="min-h-[74px] rounded-lg border border-dashed px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 sm:col-span-2"
						>
							Couldn’t load your providers — tap to retry. Managed AI still works.
						</button>
					) : null}
					{providerList.map((provider) => (
						<Tile
							key={provider.provider_id}
							selected={aiChoice === provider.provider_id}
							onClick={() => setAiChoice(provider.provider_id)}
							leading={<ProviderTypeChip type={provider.type} />}
							title={provider.label ?? provider.provider_id}
							subtitle={provider.default_model ?? providerTypeLabelFallback(provider)}
							badge={<AuthBadge auth={provider.auth} />}
						/>
					))}
					<AddTile
						title="Add a provider"
						description="Connect OpenAI, Anthropic, or another endpoint."
						onClick={() => setAddProviderOpen(true)}
					/>
				</CardContent>
			</Card>

			{/* 3. Channels — optional, reuses Channels */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						3. Channels <span className="font-normal text-muted-foreground">· optional</span>
					</CardTitle>
					<CardDescription>
						Prepare a bot now, then link it from the agent page once deployment finishes.
					</CardDescription>
				</CardHeader>
				<CardContent className={TWO_TILE_GRID_CLASS}>
					<Tile
						selected
						leading={
							<IconChip tint="bg-muted text-muted-foreground">
								<CalendarClock />
							</IconChip>
						}
						title="Link after deploy"
						subtitle="Channel links need the agent identity created during provisioning."
						badge={<Badge variant="secondary">Default</Badge>}
					/>
					{channels.isLoading ? <Skeleton className="h-[74px] w-full rounded-lg" /> : null}
					{channels.error
						? null
						: channelList.map((channel) => <ChannelInfoTile key={channel.id} channel={channel} />)}
					<AddTile
						title="Connect a channel"
						description="Prepare a bot; link it after provisioning."
						onClick={() => setConnectChannelOpen(true)}
					/>
				</CardContent>
			</Card>

			{/* 4. Compute */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">4. Compute</CardTitle>
					<CardDescription>
						Free gives one active hosted deployment. Performance is billed per deployment and can
						run both optional runtimes.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<div className="grid gap-2 sm:grid-cols-2">
						<Tile
							selected={compute === "free"}
							onClick={!freeSlotUnavailable ? () => setComputeTier("free") : undefined}
							leading={
								<IconChip tint="bg-identity-3-bg text-identity-3-fg">
									<Cpu />
								</IconChip>
							}
							title="Free"
							subtitle={
								freeSlotUsed
									? "Free slot already in use"
									: freeSlotPending
										? "Checking Free slot…"
										: deployments.error
											? "Free slot check unavailable"
											: freePlan
												? `${freePlan.vcpu} vCPU / ${freePlan.ram_gb} GB burst · one active deployment`
												: "$0 · Codex included"
							}
							badge={<Badge variant="secondary">$0</Badge>}
							disabled={freeSlotUnavailable}
						/>
						<Tile
							selected={compute === "performance"}
							onClick={perfPlan ? () => setComputeTier("performance") : undefined}
							leading={
								<IconChip tint="bg-identity-8-bg text-identity-8-fg">
									<Zap />
								</IconChip>
							}
							title="Performance"
							subtitle={
								perfPlan
									? `${perfPlan.vcpu} vCPU / ${perfPlan.ram_gb} GB · per-agent subscription`
									: "Performance plan unavailable"
							}
							badge={
								<Badge>
									{perfOffer
										? `${formatCentsCompact(perfOffer.effective_monthly_price_cents)}/mo`
										: perfPlan
											? `${formatCentsCompact(perfPlan.price_cents)}/mo`
											: "Unavailable"}
								</Badge>
							}
							disabled={!perfPlan}
						/>
					</div>
					{compute === "performance" && perfOffers.length > 1 ? (
						<div className="flex flex-col gap-2">
							<TermSwitcher offers={perfOffers} value={term} onChange={setTerm} />
						</div>
					) : null}
					<ComputeStatusLine
						compute={compute}
						freeSlotPending={freeSlotPending}
						freeSlotUsed={freeSlotUsed}
						deploymentsError={deployments.error}
						freePlan={freePlan}
						perfOffer={perfOffer}
					/>
				</CardContent>
			</Card>

			{/* 5. Personalize — name, personality, language, timezone */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						5. Personalize <span className="font-normal text-muted-foreground">· optional</span>
					</CardTitle>
					<CardDescription>Give your agent a name, tone, language, and timezone.</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<label htmlFor="agent-name" className="text-sm text-muted-foreground">
							Name
						</label>
						<Input
							id="agent-name"
							value={agentName}
							onChange={(e) => setAgentName(e.target.value)}
							placeholder="My assistant"
							maxLength={60}
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="agent-personality" className="text-sm text-muted-foreground">
								Personality
							</label>
							<Select
								value={personality || "default"}
								onValueChange={(v) => setPersonality(v === "default" ? "" : v)}
							>
								<SelectTrigger id="agent-personality">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">Default</SelectItem>
									{PERSONALITY_PRESETS.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="agent-language" className="text-sm text-muted-foreground">
								Language
							</label>
							<Select
								value={language || "default"}
								onValueChange={(v) => setLanguage(v === "default" ? "" : v)}
							>
								<SelectTrigger id="agent-language">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">Default</SelectItem>
									{LANGUAGE_OPTIONS.map((l) => (
										<SelectItem key={l.code} value={l.code}>
											{l.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{tzOptions.length > 0 ? (
						<div className="flex flex-col gap-1.5">
							<label htmlFor="agent-timezone" className="text-sm text-muted-foreground">
								Timezone
							</label>
							<TimezoneCombobox value={timezone} onValueChange={setTimezone} options={tzOptions} />
						</div>
					) : null}
				</CardContent>
			</Card>

			{/* Sticky action bar */}
			<div className="sticky bottom-0 -mx-4 border-t bg-background/90 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<p className="min-w-0 truncate text-sm text-muted-foreground">{summaryLine}</p>
					<Button
						size="lg"
						onClick={() => runAction(onDeploy)}
						disabled={!canSubmit}
						className="w-full sm:w-auto"
					>
						{submitting ? <Spinner /> : <Rocket />}
						{submitting ? "Working…" : deployLabel}
					</Button>
				</div>
			</div>

			{/* Create a provider / channel WITHOUT leaving the wizard — the lists
			    refetch on success so the new one appears as a choice above. */}
			<AddProviderDialog open={addProviderOpen} onOpenChange={setAddProviderOpen} />
			<ConnectBotDialog open={connectChannelOpen} onOpenChange={setConnectChannelOpen} />
		</div>
	);
}

function providerTypeLabelFallback(provider: AiProvider): string {
	return provider.base_url.replace(/^https?:\/\//, "");
}
