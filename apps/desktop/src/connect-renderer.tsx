import type {
	ClawdiDesktopConnectBridge,
	ClawdiDesktopShellBridge,
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopDetectedAgent,
	DesktopInstallationState,
	DesktopReconnectCandidate,
} from "@clawdi/shared/desktop";
import {
	ArrowRight,
	Check,
	CircleCheckBig,
	FolderInput,
	LoaderCircle,
	LogIn,
	RefreshCw,
	ShieldCheck,
	Sparkles,
	TriangleAlert,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentBrandIcon } from "./agent-brand-icon";
import "./connect-renderer.css";

declare global {
	interface Window {
		clawdiConnect?: ClawdiDesktopConnectBridge;
		clawdiDesktop?: ClawdiDesktopShellBridge;
	}
}

type Stage =
	| "loading"
	| "install"
	| "welcome"
	| "authenticating"
	| "select"
	| "moving"
	| "connecting"
	| "complete"
	| "error";

function ConnectApp({ bridge }: { bridge: ClawdiDesktopConnectBridge }) {
	const [stage, setStage] = useState<Stage>("loading");
	const [bootstrap, setBootstrap] = useState<DesktopBootstrapState | null>(null);
	const [installation, setInstallation] = useState<DesktopInstallationState>({
		requiresMove: false,
	});
	const [agents, setAgents] = useState<DesktopDetectedAgent[]>([]);
	const [reconnectCandidates, setReconnectCandidates] = useState<DesktopReconnectCandidate[]>([]);
	const [selected, setSelected] = useState<Set<DesktopAgentType>>(new Set());
	const [connectionModes, setConnectionModes] = useState<Map<DesktopAgentType, string>>(new Map());
	const [failure, setFailure] = useState<string | null>(null);
	const [cancellingAuth, setCancellingAuth] = useState(false);

	const fail = useCallback((error: unknown) => {
		setFailure(error instanceof Error ? error.message : "Setup could not be completed.");
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
							: [[agent.type, "new"]],
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
			setInstallation(location);
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
			const candidates = await bridge.listReconnectableAgents();
			applyAgentChoices(detected, candidates);
			setStage("select");
		} catch (error) {
			fail(error);
		}
	}, [applyAgentChoices, bridge, fail]);

	useEffect(() => {
		void load();
	}, [load]);

	async function authenticate() {
		setStage("authenticating");
		setFailure(null);
		try {
			const result = await bridge.authenticate();
			if (result.status === "cancelled") {
				setStage("welcome");
				return;
			}
			setBootstrap(result.state);
			await loadAgents();
		} catch (error) {
			fail(error);
		} finally {
			setCancellingAuth(false);
		}
	}

	async function cancelAuthentication() {
		setCancellingAuth(true);
		try {
			await bridge.cancelAuthentication();
		} catch (error) {
			fail(error);
		}
	}

	async function connect() {
		const requestedTypes =
			selected.size > 0
				? [...selected]
				: agents.filter((agent) => agent.registered).map((agent) => agent.type);
		if (requestedTypes.length === 0) return;
		const requested: DesktopAgentConnection[] = requestedTypes.map((type) => {
			const mode = connectionModes.get(type);
			if (selected.has(type) && !mode) {
				throw new Error("Choose whether to reconnect or create a new Agent.");
			}
			return { type, ...(mode && mode !== "new" ? { reconnectAgentId: mode } : {}) };
		});
		setStage("connecting");
		setFailure(null);
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
			if (result.status === "cancelled") {
				setStage("install");
				return;
			}
			if (result.status === "not-required") {
				setInstallation({ requiresMove: false });
				await load();
			}
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

	return (
		<main className="app-shell">
			<header className="titlebar">
				<div className="brand-mark" aria-hidden="true">
					<img src="./clawdi-logo.png" alt="" />
				</div>
				<div className="titlebar-copy">
					<p>Clawdi</p>
					<h1>Connect Agent</h1>
				</div>
			</header>

			<section className="content">
				{stage === "loading" ? (
					<Centered icon={<LoaderCircle className="spin" />} title="Checking this Mac" />
				) : null}

				{stage === "install" ? (
					<div className="stack">
						<div className="notice install-notice">
							<span className="icon-tile">
								<FolderInput />
							</span>
							<div>
								<h2>Move Clawdi to Applications</h2>
								<p>
									Clawdi must run from Applications so macOS can safely start its bundled runtime
									and background sync.
								</p>
							</div>
						</div>
						<footer className="actions">
							<button
								className="button primary"
								type="button"
								onClick={() => void moveToApplications()}
							>
								Move to Applications <ArrowRight />
							</button>
						</footer>
					</div>
				) : null}

				{stage === "welcome" ? (
					<Welcome agents={agents} onContinue={() => void authenticate()} />
				) : null}

				{stage === "authenticating" ? (
					<div className="stack">
						<Centered
							icon={<LoaderCircle className="spin" />}
							title="Finish signing in in your browser"
							description="Clawdi is waiting for the secure browser authorization to finish."
						/>
						<footer className="actions">
							<button
								className="button secondary"
								type="button"
								disabled={cancellingAuth}
								onClick={() => void cancelAuthentication()}
							>
								{cancellingAuth ? <LoaderCircle className="spin" /> : <X />}
								{cancellingAuth ? "Cancelling…" : "Cancel sign-in"}
							</button>
						</footer>
					</div>
				) : null}

				{stage === "select" ? (
					<AgentSelection
						agents={agents}
						reconnectCandidates={reconnectCandidates}
						selected={selected}
						connectionModes={connectionModes}
						account={bootstrap?.auth.user?.email}
						daemonReady={bootstrap?.daemon.running === true}
						requiresMove={installation.requiresMove}
						onToggle={(type, checked) => {
							setSelected((current) => {
								const next = new Set(current);
								if (checked) next.add(type);
								else next.delete(type);
								return next;
							});
						}}
						onRefresh={() => void loadAgents()}
						onConnectionModeChange={(type, mode) => {
							setConnectionModes((current) => new Map(current).set(type, mode));
						}}
						onConnect={() => void connect()}
						onMoveToApplications={() => void moveToApplications()}
						onOpenDashboard={() => void openDashboard()}
					/>
				) : null}

				{stage === "moving" ? (
					<Centered
						icon={<FolderInput />}
						title="Moving Clawdi to Applications"
						description="Clawdi will reopen automatically so setup can continue safely."
					/>
				) : null}

				{stage === "connecting" ? (
					<Centered
						icon={<LoaderCircle className="spin" />}
						title="Connecting your Agents"
						description="Clawdi is registering them and starting background sync."
					/>
				) : null}

				{stage === "complete" ? (
					<div className="stack">
						<Centered
							icon={<CircleCheckBig />}
							title="Agents connected"
							description="Background sync keeps running when Clawdi is closed."
							tone="success"
						/>
						<footer className="actions">
							<button className="button primary" type="button" onClick={() => void openDashboard()}>
								Open dashboard <ArrowRight />
							</button>
						</footer>
					</div>
				) : null}

				{stage === "error" ? (
					<div className="stack">
						<div className="error-notice" role="alert">
							<TriangleAlert />
							<div>
								<h2>Couldn't finish setup</h2>
								<p>{failure ?? "Try again."}</p>
							</div>
						</div>
						<footer className="actions">
							<button className="button secondary" type="button" onClick={() => void load()}>
								<RefreshCw /> Retry
							</button>
						</footer>
					</div>
				) : null}
			</section>
		</main>
	);
}

function Welcome({ agents, onContinue }: { agents: DesktopDetectedAgent[]; onContinue(): void }) {
	const detected = agents.filter((agent) => agent.detected);
	return (
		<div className="stack welcome-step">
			<div className="welcome-hero">
				<span className="status-icon welcome-icon">
					<Sparkles />
				</span>
				<h2>Welcome to Clawdi</h2>
				<p>
					{detected.length > 0
						? `We found ${detected.length} supported Agent${detected.length === 1 ? "" : "s"} on this Mac. Sign in to connect or recover them.`
						: "Sign in to Clawdi, then connect a supported Agent whenever it is available on this Mac."}
				</p>
			</div>
			{detected.length > 0 ? (
				<ul className="welcome-agents" aria-label="Agents found on this Mac">
					{detected.map((agent) => (
						<li className="welcome-agent" key={agent.type}>
							<AgentBrandIcon type={agent.type} />
							<span>
								<strong>{agent.displayName}</strong>
								<small>{agent.version ?? "Local data found"}</small>
							</span>
						</li>
					))}
				</ul>
			) : null}
			<div className="notice welcome-security">
				<span className="icon-tile">
					<ShieldCheck />
				</span>
				<div>
					<h2>One secure sign-in</h2>
					<p>
						Clawdi opens your browser for authorization. The bundled CLI keeps the local credential
						used by both sync and this app.
					</p>
				</div>
			</div>
			<footer className="actions">
				<button className="button primary" type="button" onClick={onContinue}>
					Sign in to continue <ArrowRight />
				</button>
			</footer>
		</div>
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
	const found = useMemo(
		() => agents.filter((agent) => agent.detected || agent.registered).length,
		[agents],
	);
	const canRepairDaemon = !daemonReady && agents.some((agent) => agent.registered);
	const shouldConnect = selected.size > 0 || canRepairDaemon;
	const connectionChoiceRequired = [...selected].some((type) => !connectionModes.has(type));
	return (
		<div className="stack">
			<div className="section-heading">
				<div>
					<h2>{found > 0 ? `Found ${found} Agent${found === 1 ? "" : "s"}` : "No Agents found"}</h2>
					<p>{account ? `Connecting to ${account}` : "Select the Agents to connect."}</p>
				</div>
				<button
					aria-label="Scan again"
					className="icon-button"
					type="button"
					onClick={onRefresh}
					title="Scan again"
				>
					<RefreshCw />
				</button>
			</div>

			<div className="agent-list">
				{agents.map((agent) => {
					const available = agent.detected && !agent.registered;
					const candidates = reconnectCandidates.filter(
						(candidate) => candidate.type === agent.type,
					);
					return (
						<div className={`agent-row${available ? "" : " unavailable"}`} key={agent.type}>
							<input
								type="checkbox"
								aria-label={`Connect ${agent.displayName}`}
								checked={agent.registered || selected.has(agent.type)}
								disabled={!available}
								onChange={(event) => onToggle(agent.type, event.currentTarget.checked)}
							/>
							<AgentBrandIcon type={agent.type} />
							<span className="agent-copy">
								<strong>{agent.displayName}</strong>
								<small>
									{agent.registered
										? "Already connected"
										: candidates.length > 0
											? "Previous connection found"
											: agent.detected
												? (agent.version ?? "Local data found")
												: agent.inspection === "failed"
													? "Couldn't inspect"
													: "Not installed"}
								</small>
								{available && selected.has(agent.type) && candidates.length > 0 ? (
									<select
										aria-label={`Connection for ${agent.displayName}`}
										value={connectionModes.get(agent.type) ?? ""}
										onChange={(event) =>
											onConnectionModeChange(agent.type, event.currentTarget.value)
										}
									>
										<option value="" disabled>
											Choose how to connect…
										</option>
										<option value="new">Connect as a new Agent</option>
										{candidates.map((candidate) => (
											<option value={candidate.id} key={candidate.id}>
												Reconnect to {candidate.name} · {candidate.machineName}
											</option>
										))}
									</select>
								) : null}
							</span>
							{agent.registered ? <Check className="row-check" /> : null}
						</div>
					);
				})}
			</div>

			{requiresMove && shouldConnect ? (
				<div className="notice install-notice">
					<span className="icon-tile">
						<FolderInput />
					</span>
					<div>
						<h2>Move Clawdi to Applications</h2>
						<p>
							Background sync must be installed from Applications so macOS always starts the correct
							bundled runtime.
						</p>
					</div>
				</div>
			) : null}

			<footer className="actions">
				{requiresMove && shouldConnect ? (
					<button className="button secondary" type="button" onClick={onOpenDashboard}>
						Open dashboard
					</button>
				) : null}
				<button
					className="button primary"
					type="button"
					disabled={connectionChoiceRequired}
					onClick={
						requiresMove && shouldConnect
							? onMoveToApplications
							: shouldConnect
								? onConnect
								: onOpenDashboard
					}
				>
					{connectionChoiceRequired
						? "Choose how to connect"
						: requiresMove && shouldConnect
							? "Move to Applications"
							: selected.size > 0
								? `Connect ${selected.size} Agent${selected.size === 1 ? "" : "s"}`
								: canRepairDaemon
									? "Start background sync"
									: "Open dashboard"}
					<ArrowRight />
				</button>
			</footer>
		</div>
	);
}

function DashboardFailureApp({ bridge }: { bridge: ClawdiDesktopShellBridge }) {
	const [pending, setPending] = useState<"retry" | "reauth" | null>(null);
	const [failed, setFailed] = useState(false);

	async function run(action: "retry" | "reauth") {
		setPending(action);
		setFailed(false);
		try {
			await (action === "retry" ? bridge.retryDashboard() : bridge.signIn());
		} catch {
			setFailed(true);
		} finally {
			setPending(null);
		}
	}

	return (
		<main className="app-shell">
			<header className="titlebar dashboard-titlebar">
				<div className="brand-mark" aria-hidden="true">
					<img src="./clawdi-logo.png" alt="" />
				</div>
				<div className="titlebar-copy">
					<p>Clawdi</p>
					<h1>Dashboard</h1>
				</div>
			</header>
			<section className="content failure-content">
				<div className="stack">
					<Centered
						icon={<TriangleAlert />}
						title={failed ? "Couldn't reconnect" : "Dashboard unavailable"}
						description={
							failed
								? "Try again, or open Connect Agent to check the local connection."
								: "Clawdi couldn't load your dashboard. Check your connection and try again."
						}
					/>
					<footer className="actions failure-actions">
						<button
							className="button secondary"
							type="button"
							disabled={pending !== null}
							onClick={() => void run("reauth")}
						>
							<LogIn /> Sign in again
						</button>
						<button
							className="button primary"
							type="button"
							disabled={pending !== null}
							onClick={() => void run("retry")}
						>
							<RefreshCw className={pending === "retry" ? "spin" : undefined} /> Retry
						</button>
					</footer>
				</div>
			</section>
		</main>
	);
}

function Centered({
	icon,
	title,
	description,
	tone = "brand",
}: {
	icon: React.ReactNode;
	title: string;
	description?: string;
	tone?: "brand" | "success";
}) {
	return (
		<div className="centered">
			<span className={`status-icon ${tone}`}>{icon}</span>
			<h2>{title}</h2>
			{description ? <p>{description}</p> : null}
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Clawdi connect root is missing.");
const failureSurface = new URLSearchParams(window.location.search).get("surface");
if (failureSurface === "dashboard-failure" && window.clawdiDesktop) {
	document.title = "Dashboard unavailable · Clawdi";
	createRoot(root).render(<DashboardFailureApp bridge={window.clawdiDesktop} />);
} else if (window.clawdiConnect) {
	createRoot(root).render(<ConnectApp bridge={window.clawdiConnect} />);
} else {
	throw new Error("Clawdi renderer bridge is unavailable.");
}
