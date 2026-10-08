import type {
	ClawdiDesktopConnectBridge,
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopAuthenticationProgress,
	DesktopBootstrapState,
	DesktopConnectView,
	DesktopDetectedAgent,
	DesktopReconnectCandidate,
} from "@clawdi/shared/desktop";
import { skeletonClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import {
	ArrowRight,
	Check,
	CircleCheck,
	ExternalLink,
	Folder,
	FolderInput,
	FolderPlus,
	LoaderCircle,
	RefreshCw,
	TriangleAlert,
	X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AgentBrandIcon } from "./agent-brand-icon";
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Button,
	Checkbox,
	InsetEmptyState,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./connect-ui";

type Stage =
	| "loading"
	| "install"
	| "moving"
	| "welcome"
	| "signing-in"
	| "sign-in-ended"
	| "select"
	| "connecting"
	| "complete"
	| "error";

type SignInEnding = "expired" | "denied";

const NEW_AGENT = "new";

/** Native window titles follow macOS HIG Title Case. */
const WINDOW_TITLES: Record<Stage, string> = {
	loading: "Connect Agents",
	install: "Move to Applications",
	moving: "Move to Applications",
	welcome: "Sign In",
	"signing-in": "Sign In",
	"sign-in-ended": "Sign In",
	select: "Choose Agents",
	connecting: "Connecting Agents",
	complete: "Agents Connected",
	error: "Needs Attention",
};

export function ConnectApp({ bridge }: { bridge: ClawdiDesktopConnectBridge }) {
	const [view, setView] = useState<DesktopConnectView | null>(null);
	const [stage, setStage] = useState<Stage>("loading");
	const [bootstrap, setBootstrap] = useState<DesktopBootstrapState | null>(null);
	const [requiresMove, setRequiresMove] = useState(false);
	const [agents, setAgents] = useState<DesktopDetectedAgent[]>([]);
	const [reconnectCandidates, setReconnectCandidates] = useState<DesktopReconnectCandidate[]>([]);
	const [selected, setSelected] = useState<ReadonlySet<DesktopAgentType>>(new Set());
	const [connectionModes, setConnectionModes] = useState<ReadonlyMap<DesktopAgentType, string>>(
		new Map(),
	);
	const [connecting, setConnecting] = useState<DesktopAgentType[]>([]);
	const [failure, setFailure] = useState<string | null>(null);
	const [authProgress, setAuthProgress] = useState<DesktopAuthenticationProgress | null>(null);
	const [signInEnding, setSignInEnding] = useState<SignInEnding>("denied");
	const [canceling, setCanceling] = useState(false);
	const signInInterruption = useRef<"canceled" | "expired" | null>(null);
	const stageRef = useRef(stage);
	stageRef.current = stage;

	useEffect(() => bridge.onAuthenticationProgress(setAuthProgress), [bridge]);

	useEffect(() => {
		document.title = `${view === "exclude-projects" ? "Exclude Projects" : WINDOW_TITLES[stage]} · Clawdi`;
	}, [stage, view]);

	const fail = useCallback((error: unknown) => {
		setFailure(error instanceof Error ? error.message : "Setup couldn't be completed.");
		setStage("error");
	}, []);

	const applyAgentChoices = useCallback(
		(detected: DesktopDetectedAgent[], candidates: DesktopReconnectCandidate[]) => {
			setAgents(detected);
			setReconnectCandidates(candidates);
			const available = detected.filter((agent) => agent.detected && !agent.registered);
			setSelected(new Set(available.map((agent) => agent.type)));
			setConnectionModes(
				new Map(
					available.flatMap((agent) =>
						candidates.some((candidate) => candidate.type === agent.type)
							? []
							: [[agent.type, NEW_AGENT] as const],
					),
				),
			);
		},
		[],
	);

	const loadAgents = useCallback(async () => {
		setStage("loading");
		setFailure(null);
		try {
			const [detected, candidates] = await Promise.all([
				bridge.detectAgents(),
				bridge.listReconnectableAgents(),
			]);
			applyAgentChoices(detected, candidates);
			setStage("select");
		} catch (error) {
			fail(error);
		}
	}, [applyAgentChoices, bridge, fail]);

	const load = useCallback(async () => {
		setStage("loading");
		setFailure(null);
		try {
			const location = await bridge.getInstallationState();
			setRequiresMove(location.requiresMove);
			if (location.requiresMove) {
				setStage("install");
				return;
			}
			const detected = await bridge.detectAgents();
			setAgents(detected);
			const state = await bridge.getBootstrapState();
			setBootstrap(state);
			if (!state.auth.authenticated) {
				setStage("welcome");
				return;
			}
			applyAgentChoices(detected, await bridge.listReconnectableAgents());
			setStage("select");
		} catch (error) {
			fail(error);
		}
	}, [applyAgentChoices, bridge, fail]);

	useEffect(() => {
		let active = true;
		void bridge
			.takeRequestedView()
			.catch(() => "connect" as const)
			.then((requested) => {
				if (active) setView(requested);
			});
		void load();
		return () => {
			active = false;
		};
	}, [bridge, load]);

	useEffect(
		() =>
			bridge.onViewRequested((requested) => {
				setView(requested);
				const busy = ["signing-in", "connecting", "moving"].includes(stageRef.current);
				if (requested === "connect" && !busy) void load();
			}),
		[bridge, load],
	);

	async function signIn() {
		signInInterruption.current = null;
		setAuthProgress(null);
		setFailure(null);
		setStage("signing-in");
		try {
			const result = await bridge.authenticate();
			if (result.status === "cancelled") {
				if (signInInterruption.current === "canceled") {
					setStage("welcome");
				} else {
					setSignInEnding(signInInterruption.current === "expired" ? "expired" : "denied");
					setStage("sign-in-ended");
				}
				return;
			}
			setBootstrap(result.state);
			await loadAgents();
		} catch (error) {
			if (signInInterruption.current === "expired") {
				setSignInEnding("expired");
				setStage("sign-in-ended");
			} else {
				fail(error);
			}
		} finally {
			setCanceling(false);
		}
	}

	const interruptSignIn = useCallback(
		async (reason: "canceled" | "expired") => {
			signInInterruption.current ??= reason;
			if (reason === "canceled") setCanceling(true);
			try {
				await bridge.cancelAuthentication();
			} catch (error) {
				fail(error);
			}
		},
		[bridge, fail],
	);

	async function connect() {
		const requestedTypes =
			selected.size > 0
				? [...selected]
				: agents.filter((agent) => agent.registered).map((agent) => agent.type);
		if (requestedTypes.length === 0) return;
		const requested: DesktopAgentConnection[] = requestedTypes.map((type) => {
			const candidate = reconnectCandidates.find((item) => item.id === connectionModes.get(type));
			return candidate
				? {
						type,
						reconnectAgentId: candidate.id,
						...(isRecentOtherMachine(candidate) ? { confirmTakeover: true } : {}),
					}
				: { type };
		});
		setConnecting(requestedTypes);
		setFailure(null);
		setStage("connecting");
		try {
			await bridge.connectAgents(requested);
			setStage("complete");
		} catch (error) {
			fail(error);
		}
	}

	async function moveToApplications() {
		setStage("moving");
		setFailure(null);
		try {
			const result = await bridge.moveToApplicationsFolder();
			if (result.status === "cancelled") setStage("install");
			else if (result.status === "not-required") await load();
		} catch (error) {
			fail(error);
		}
	}

	async function openDashboard() {
		try {
			await bridge.openDashboard();
		} catch (error) {
			fail(error);
		}
	}

	if (view === "exclude-projects") {
		return (
			<Shell>
				<ExcludedProjects bridge={bridge} onDone={() => setView("connect")} />
			</Shell>
		);
	}

	const account = bootstrap?.auth.user?.email;
	return (
		<Shell>
			{stage === "loading" ? (
				<Page
					title="Connect agents"
					description="Looking for agents on this computer…"
					footer={null}
				>
					<AgentListSkeleton />
				</Page>
			) : null}

			{stage === "install" || stage === "moving" ? (
				<Page
					title="Move Clawdi to Applications"
					description="Clawdi needs to run from Applications so macOS can start sync safely."
					footer={
						<Button disabled={stage === "moving"} onClick={() => void moveToApplications()}>
							{stage === "moving" ? <LoaderCircle className="animate-spin" /> : <FolderInput />}
							{stage === "moving" ? "Moving…" : "Move to Applications"}
						</Button>
					}
				>
					{stage === "moving" ? (
						<p className="text-sm text-muted-foreground">
							Clawdi reopens automatically after it moves.
						</p>
					) : null}
				</Page>
			) : null}

			{stage === "welcome" ? <Welcome agents={agents} onSignIn={() => void signIn()} /> : null}

			{stage === "signing-in" ? (
				<SigningIn
					progress={authProgress}
					canceling={canceling}
					onCancel={() => void interruptSignIn("canceled")}
					onExpired={() => void interruptSignIn("expired")}
					onReopen={() => bridge.reopenVerificationPage()}
				/>
			) : null}

			{stage === "sign-in-ended" ? (
				<Page
					title={signInEnding === "expired" ? "Sign-in code expired" : "Sign-in didn't finish"}
					description={
						signInEnding === "expired"
							? "Try again to get a new code."
							: "The request was denied or canceled in your browser. Try again to get a new code."
					}
					footer={<Button onClick={() => void signIn()}>Try again</Button>}
				/>
			) : null}

			{stage === "select" ? (
				<AgentSelection
					agents={agents}
					reconnectCandidates={reconnectCandidates}
					selected={selected}
					connectionModes={connectionModes}
					account={account}
					daemonReady={bootstrap?.daemon.running === true}
					requiresMove={requiresMove}
					onToggle={(type, checked) =>
						setSelected((current) => {
							const next = new Set(current);
							if (checked) next.add(type);
							else next.delete(type);
							return next;
						})
					}
					onRefresh={() => void loadAgents()}
					onConnectionModeChange={(type, mode) =>
						setConnectionModes((current) => new Map(current).set(type, mode))
					}
					onConnect={() => void connect()}
					onMoveToApplications={() => void moveToApplications()}
					onOpenDashboard={() => void openDashboard()}
				/>
			) : null}

			{stage === "connecting" ? (
				<Page
					title="Connecting agents"
					description="Registering your agents and starting sync…"
					footer={null}
				>
					<AgentList>
						{agents
							.filter((agent) => connecting.includes(agent.type))
							.map((agent) => (
								<AgentRow
									key={agent.type}
									agent={agent}
									meta="Connecting…"
									trailing={<LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
								/>
							))}
					</AgentList>
				</Page>
			) : null}

			{stage === "complete" ? (
				<Page
					title="Agents connected"
					description={`${account ? `Signed in as ${account}. ` : ""}Sync keeps running when Clawdi is closed.`}
					footer={
						<Button onClick={() => void openDashboard()}>
							Open dashboard <ArrowRight data-icon="inline-end" />
						</Button>
					}
				>
					<AgentList>
						{agents
							.filter((agent) => connecting.includes(agent.type))
							.map((agent) => (
								<AgentRow
									key={agent.type}
									agent={agent}
									meta="Sync started"
									trailing={<CircleCheck className="size-4 text-success" />}
								/>
							))}
					</AgentList>
				</Page>
			) : null}

			{stage === "error" ? (
				<Page
					title="Couldn't finish setup"
					footer={
						<Button variant="outline" onClick={() => void load()}>
							<RefreshCw data-icon="inline-start" /> Try again
						</Button>
					}
				>
					<Alert variant="destructive">
						<TriangleAlert />
						<AlertDescription>{failure ?? "Try again."}</AlertDescription>
					</Alert>
				</Page>
			) : null}
		</Shell>
	);
}

function Shell({ children }: { children: ReactNode }) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header
				data-window-drag-region
				className="flex h-12 shrink-0 items-center justify-center gap-2 border-b border-border"
			>
				<img src="./clawdi-logo.png" alt="" className="size-5" draggable={false} />
				<span className="text-sm font-medium">Clawdi</span>
			</header>
			{children}
		</div>
	);
}

function Page({
	title,
	description,
	action,
	footer,
	children,
}: {
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	footer?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<>
			<main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
				<div className="mx-auto flex w-full max-w-xl flex-col gap-5">
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0 space-y-1">
							<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
							{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
						</div>
						{action}
					</div>
					{children}
				</div>
			</main>
			{footer ? (
				<footer className="shrink-0 border-t border-border px-6 py-3">
					<div className="mx-auto flex w-full max-w-xl items-center justify-end gap-2">
						{footer}
					</div>
				</footer>
			) : null}
		</>
	);
}

function AgentList({ label, children }: { label?: string; children: ReactNode }) {
	return (
		<ul
			aria-label={label}
			className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
		>
			{children}
		</ul>
	);
}

function AgentRow({
	agent,
	meta,
	leading,
	trailing,
	children,
	muted = false,
}: {
	agent: DesktopDetectedAgent;
	meta: string;
	leading?: ReactNode;
	trailing?: ReactNode;
	children?: ReactNode;
	muted?: boolean;
}) {
	return (
		<li className="flex flex-col gap-3 px-4 py-3">
			<div className="flex items-center gap-3">
				{leading}
				<span className={cn("contents", muted && "*:opacity-60")}>
					<AgentBrandIcon type={agent.type} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate text-sm font-medium">{agent.displayName}</span>
						<span className="truncate text-xs text-muted-foreground">{meta}</span>
					</span>
				</span>
				{trailing}
			</div>
			{children}
		</li>
	);
}

function AgentListSkeleton() {
	return (
		<AgentList>
			{[0, 1, 2].map((row) => (
				<li key={row} className="flex items-center gap-3 px-4 py-3">
					<span className={cn(skeletonClassName, "size-8")} />
					<span className="flex flex-1 flex-col gap-1.5">
						<span className={cn(skeletonClassName, "h-3.5 w-28")} />
						<span className={cn(skeletonClassName, "h-3 w-16")} />
					</span>
				</li>
			))}
		</AgentList>
	);
}

function Welcome({ agents, onSignIn }: { agents: DesktopDetectedAgent[]; onSignIn(): void }) {
	const detected = agents.filter((agent) => agent.detected);
	return (
		<Page
			title="Welcome to Clawdi"
			description={
				detected.length > 0
					? `Found ${pluralize(detected.length, "agent")} on this computer. Sign in to connect them.`
					: "Sign in, then connect a supported agent whenever you install one."
			}
			footer={
				<Button onClick={onSignIn}>
					Sign in <ArrowRight data-icon="inline-end" />
				</Button>
			}
		>
			{detected.length > 0 ? (
				<AgentList label="Agents found on this computer">
					{detected.map((agent) => (
						<AgentRow key={agent.type} agent={agent} meta={agent.version ?? "Local data found"} />
					))}
				</AgentList>
			) : null}
			<p className="text-sm text-muted-foreground">
				Your browser approves the sign-in. Clawdi keeps you signed in on this computer.
			</p>
		</Page>
	);
}

function SigningIn({
	progress,
	canceling,
	onCancel,
	onExpired,
	onReopen,
}: {
	progress: DesktopAuthenticationProgress | null;
	canceling: boolean;
	onCancel(): void;
	onExpired(): void;
	onReopen(): Promise<unknown>;
}) {
	const remaining = useSecondsUntil(progress?.expiresAt ?? null);
	const [reopenFailed, setReopenFailed] = useState(false);
	const expired = remaining !== null && remaining <= 0;

	const reportedExpiry = useRef(false);
	useEffect(() => {
		if (!expired || reportedExpiry.current) return;
		reportedExpiry.current = true;
		onExpired();
	}, [expired, onExpired]);

	async function reopen() {
		setReopenFailed(false);
		try {
			await onReopen();
		} catch {
			setReopenFailed(true);
		}
	}

	return (
		<Page
			title="Continue in your browser"
			description="Check that your browser shows this code, then approve the sign-in."
			footer={
				<>
					<Button variant="ghost" disabled={canceling} onClick={onCancel}>
						{canceling ? <LoaderCircle className="animate-spin" /> : null}
						{canceling ? "Canceling…" : "Cancel"}
					</Button>
					<Button variant="outline" disabled={!progress || canceling} onClick={() => void reopen()}>
						<ExternalLink data-icon="inline-start" /> Reopen browser
					</Button>
				</>
			}
		>
			<div
				role="status"
				aria-label="Sign-in code"
				className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-8 text-center"
			>
				<span className="text-xs text-muted-foreground">Sign-in code</span>
				{progress ? (
					<span className="font-mono text-3xl font-medium tracking-[0.2em] select-text">
						{progress.userCode}
					</span>
				) : (
					<span className={cn(skeletonClassName, "h-9 w-48")} />
				)}
				<span className="text-xs text-muted-foreground tabular-nums">
					{progress === null
						? "Opening your browser…"
						: remaining === null || remaining <= 0
							? "Code expired"
							: `Expires in ${formatCountdown(remaining)}`}
				</span>
			</div>
			{reopenFailed ? (
				<p role="alert" className="text-sm text-destructive">
					Couldn't open your browser. Try again, or open Clawdi in your browser and enter the code.
				</p>
			) : null}
		</Page>
	);
}

function AgentSelection({
	agents,
	reconnectCandidates,
	selected,
	connectionModes,
	account,
	daemonReady,
	requiresMove,
	onToggle,
	onRefresh,
	onConnectionModeChange,
	onConnect,
	onMoveToApplications,
	onOpenDashboard,
}: {
	agents: DesktopDetectedAgent[];
	reconnectCandidates: DesktopReconnectCandidate[];
	selected: ReadonlySet<DesktopAgentType>;
	connectionModes: ReadonlyMap<DesktopAgentType, string>;
	account?: string;
	daemonReady: boolean;
	requiresMove: boolean;
	onToggle(type: DesktopAgentType, checked: boolean): void;
	onRefresh(): void;
	onConnectionModeChange(type: DesktopAgentType, mode: string): void;
	onConnect(): void;
	onMoveToApplications(): void;
	onOpenDashboard(): void;
}) {
	const canStartSync = !daemonReady && agents.some((agent) => agent.registered);
	const shouldConnect = selected.size > 0 || canStartSync;
	const choiceRequired = [...selected].some((type) => !connectionModes.has(type));
	const reconnecting = [...selected].flatMap((type) => {
		const candidate = reconnectCandidates.find((item) => item.id === connectionModes.get(type));
		return candidate ? [candidate] : [];
	});
	const moveFirst = requiresMove && shouldConnect;
	const primaryLabel = choiceRequired
		? "Choose how to connect"
		: moveFirst
			? "Move to Applications"
			: selected.size > 0
				? `${reconnecting.length === selected.size ? "Reconnect" : "Connect"} ${pluralize(selected.size, "agent")}`
				: canStartSync
					? "Start sync"
					: "Open dashboard";

	return (
		<Page
			title="Choose agents"
			description={account ? `Signed in as ${account}` : "Choose the agents to connect."}
			action={
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Scan again"
					title="Scan again"
					onClick={onRefresh}
				>
					<RefreshCw />
				</Button>
			}
			footer={
				<>
					{shouldConnect ? (
						<Button variant="ghost" onClick={onOpenDashboard}>
							Open dashboard
						</Button>
					) : null}
					<Button
						disabled={choiceRequired}
						onClick={moveFirst ? onMoveToApplications : shouldConnect ? onConnect : onOpenDashboard}
					>
						{primaryLabel} <ArrowRight data-icon="inline-end" />
					</Button>
				</>
			}
		>
			{agents.length === 0 ? (
				<InsetEmptyState
					title="No supported agents found"
					description="Install a supported agent, then scan again."
				/>
			) : (
				<AgentList label="Agents on this computer">
					{agents.map((agent) => {
						const available = agent.detected && !agent.registered;
						const candidates = reconnectCandidates.filter(
							(candidate) => candidate.type === agent.type,
						);
						return (
							<AgentRow
								key={agent.type}
								agent={agent}
								muted={!available && !agent.registered}
								meta={agentMeta(agent, candidates.length > 0)}
								trailing={agent.registered ? <Check className="size-4 text-success" /> : null}
								leading={
									<Checkbox
										className="data-disabled:opacity-50"
										aria-label={`Connect ${agent.displayName}`}
										checked={agent.registered || selected.has(agent.type)}
										disabled={!available}
										onCheckedChange={(checked) => onToggle(agent.type, checked)}
									/>
								}
							>
								{available && selected.has(agent.type) && candidates.length > 0 ? (
									<Select
										items={[
											{ value: NEW_AGENT, label: "Connect as a new agent" },
											...candidates.map((candidate) => ({
												value: candidate.id,
												label: `Reconnect ${candidate.name} · ${candidate.machineName}`,
											})),
										]}
										value={connectionModes.get(agent.type) ?? null}
										onValueChange={(mode) => {
											if (mode) onConnectionModeChange(agent.type, mode);
										}}
									>
										<SelectTrigger
											size="sm"
											className="ml-11 w-[calc(100%-2.75rem)]"
											aria-label={`Connection for ${agent.displayName}`}
										>
											<SelectValue placeholder="Choose how to connect…" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NEW_AGENT}>Connect as a new agent</SelectItem>
											{candidates.map((candidate) => (
												<SelectItem key={candidate.id} value={candidate.id}>
													Reconnect {candidate.name} · {candidate.machineName}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : null}
							</AgentRow>
						);
					})}
				</AgentList>
			)}

			{reconnecting.length > 0 ? (
				<Alert>
					<TriangleAlert />
					<AlertTitle>Reconnect an existing agent</AlertTitle>
					<AlertDescription>
						{reconnecting
							.map((candidate) => `${candidate.name} moves from ${candidate.machineName}`)
							.join(", ")}{" "}
						to this computer. Stop sync on the other computer first.
					</AlertDescription>
				</Alert>
			) : null}

			{moveFirst ? (
				<Alert>
					<FolderInput />
					<AlertTitle>Move Clawdi to Applications</AlertTitle>
					<AlertDescription>
						Sync starts from Applications so macOS always runs the right version.
					</AlertDescription>
				</Alert>
			) : null}
		</Page>
	);
}

function ExcludedProjects({
	bridge,
	onDone,
}: {
	bridge: ClawdiDesktopConnectBridge;
	onDone(): void;
}) {
	const [projects, setProjects] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const run = useCallback(async (action: () => Promise<string[]>) => {
		setBusy(true);
		setFailure(null);
		try {
			setProjects(await action());
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Couldn't update excluded projects.");
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void run(() => bridge.listExcludedProjects());
	}, [bridge, run]);

	return (
		<Page
			title="Exclude projects"
			description="Clawdi doesn't sync sessions from these project folders."
			footer={
				<>
					<Button
						variant="outline"
						disabled={busy || projects === null}
						onClick={() => void run(async () => (await bridge.addExcludedProject()).projects)}
					>
						<FolderPlus data-icon="inline-start" /> Add folder…
					</Button>
					<Button onClick={onDone}>Done</Button>
				</>
			}
		>
			{failure ? (
				<Alert variant="destructive">
					<TriangleAlert />
					<AlertTitle>Couldn't update excluded projects</AlertTitle>
					<AlertDescription>{failure}</AlertDescription>
				</Alert>
			) : null}
			{projects === null ? (
				failure ? null : (
					<AgentList>
						{[0, 1].map((row) => (
							<li key={row} className="flex items-center gap-3 px-4 py-3">
								<span className={cn(skeletonClassName, "h-4 w-full")} />
							</li>
						))}
					</AgentList>
				)
			) : projects.length === 0 ? (
				<InsetEmptyState
					title="No excluded projects"
					description="Sessions from every project folder sync."
				/>
			) : (
				<AgentList label="Excluded projects">
					{projects.map((path) => (
						<li key={path} className="flex items-center gap-3 py-2 pr-2 pl-4">
							<Folder className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate font-mono text-xs select-text" title={path}>
								{path}
							</span>
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={busy}
								aria-label={`Stop excluding ${path}`}
								title="Stop excluding"
								onClick={() => void run(() => bridge.removeExcludedProject(path))}
							>
								<X />
							</Button>
						</li>
					))}
				</AgentList>
			)}
		</Page>
	);
}

function agentMeta(agent: DesktopDetectedAgent, hasPreviousConnection: boolean): string {
	if (agent.registered) return "Already connected";
	if (hasPreviousConnection) return "Previous connection found";
	if (agent.detected) return agent.version ?? "Local data found";
	return agent.inspection === "failed" ? "Couldn't inspect" : "Not installed";
}

function isRecentOtherMachine(candidate: DesktopReconnectCandidate): boolean {
	if (candidate.isThisMachine || !candidate.lastSyncAt) return false;
	const timestamp = Date.parse(candidate.lastSyncAt);
	return Number.isFinite(timestamp) && Date.now() - timestamp < 5 * 60_000;
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useSecondsUntil(deadline: string | null): number | null {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!deadline) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [deadline]);
	if (!deadline) return null;
	return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1_000));
}

function formatCountdown(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
