import type {
	ClawdiDesktopConnectBridge,
	ClawdiDesktopShellBridge,
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopDashboardState,
	DesktopDetectedAgent,
	DesktopLocalSession,
	DesktopLocalSessionDetail,
} from "@clawdi/shared/desktop";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	CircleCheckBig,
	Cloud,
	CloudOff,
	FolderInput,
	HardDrive,
	LoaderCircle,
	MessageSquare,
	RefreshCw,
	Search,
	ShieldCheck,
	TerminalSquare,
	TriangleAlert,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
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
	| "authenticate"
	| "authenticating"
	| "select"
	| "moving"
	| "connecting"
	| "complete"
	| "error";

function ConnectApp({ bridge }: { bridge: ClawdiDesktopConnectBridge }) {
	const [stage, setStage] = useState<Stage>("loading");
	const [bootstrap, setBootstrap] = useState<DesktopBootstrapState | null>(null);
	const [agents, setAgents] = useState<DesktopDetectedAgent[]>([]);
	const [selected, setSelected] = useState<Set<DesktopAgentType>>(new Set());
	const [failure, setFailure] = useState<string | null>(null);
	const [cancellingAuth, setCancellingAuth] = useState(false);

	const fail = useCallback((error: unknown) => {
		setFailure(error instanceof Error ? error.message : "Setup could not be completed.");
		setStage("error");
	}, []);

	const loadAgents = useCallback(async () => {
		setStage("loading");
		setFailure(null);
		try {
			const detected = await bridge.detectAgents();
			setAgents(detected);
			setSelected(
				new Set(
					detected
						.filter((agent) => agent.detected && !agent.registered)
						.map((agent) => agent.type),
				),
			);
			setStage("select");
		} catch (error) {
			fail(error);
		}
	}, [bridge, fail]);

	const load = useCallback(async () => {
		setStage("loading");
		setFailure(null);
		try {
			const location = await bridge.getInstallationState();
			if (location.requiresMove) {
				setStage("install");
				return;
			}
			const state = await bridge.getBootstrapState();
			setBootstrap(state);
			if (!state.auth.authenticated) {
				setStage("authenticate");
				return;
			}
			await loadAgents();
		} catch (error) {
			fail(error);
		}
	}, [bridge, fail, loadAgents]);

	useEffect(() => {
		void load();
	}, [load]);

	async function authenticate() {
		setStage("authenticating");
		setFailure(null);
		try {
			const result = await bridge.authenticate();
			if (result.status === "cancelled") {
				setStage("authenticate");
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
		const requested =
			selected.size > 0
				? [...selected]
				: agents.filter((agent) => agent.registered).map((agent) => agent.type);
		if (requested.length === 0) return;
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
					<TerminalSquare />
				</div>
				<div>
					<h1>Connect Agent</h1>
					<p>Clawdi Desktop</p>
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

				{stage === "authenticate" ? (
					<div className="stack">
						<div className="notice">
							<span className="icon-tile">
								<ShieldCheck />
							</span>
							<div>
								<h2>Sign in to Clawdi</h2>
								<p>
									Clawdi opens your default browser for secure authorization, then returns here
									automatically.
								</p>
							</div>
						</div>
						<footer className="actions">
							<button className="button primary" type="button" onClick={() => void authenticate()}>
								Continue in browser <ArrowRight />
							</button>
						</footer>
					</div>
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
						selected={selected}
						account={bootstrap?.auth.user?.email}
						daemonReady={bootstrap?.daemon.running === true}
						onToggle={(type, checked) => {
							setSelected((current) => {
								const next = new Set(current);
								if (checked) next.add(type);
								else next.delete(type);
								return next;
							});
						}}
						onRefresh={() => void loadAgents()}
						onConnect={() => void connect()}
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

function AgentSelection({
	agents,
	selected,
	account,
	daemonReady,
	onToggle,
	onRefresh,
	onConnect,
	onOpenDashboard,
}: {
	agents: DesktopDetectedAgent[];
	selected: ReadonlySet<DesktopAgentType>;
	account?: string;
	daemonReady: boolean;
	onToggle(type: DesktopAgentType, checked: boolean): void;
	onRefresh(): void;
	onConnect(): void;
	onOpenDashboard(): void;
}) {
	const found = useMemo(
		() => agents.filter((agent) => agent.detected || agent.registered).length,
		[agents],
	);
	const canRepairDaemon = !daemonReady && agents.some((agent) => agent.registered);
	const shouldConnect = selected.size > 0 || canRepairDaemon;
	return (
		<div className="stack">
			<div className="section-heading">
				<div>
					<h2>{found > 0 ? `Found ${found} Agent${found === 1 ? "" : "s"}` : "No Agents found"}</h2>
					<p>{account ? `Connecting to ${account}` : "Select the Agents to connect."}</p>
				</div>
				<button className="icon-button" type="button" onClick={onRefresh} title="Scan again">
					<RefreshCw />
				</button>
			</div>

			<div className="agent-list">
				{agents.map((agent) => {
					const available = agent.detected && !agent.registered;
					return (
						<label className={`agent-row${available ? "" : " unavailable"}`} key={agent.type}>
							<input
								type="checkbox"
								checked={agent.registered || selected.has(agent.type)}
								disabled={!available}
								onChange={(event) => onToggle(agent.type, event.currentTarget.checked)}
							/>
							<span className="agent-icon" aria-hidden="true">
								<TerminalSquare />
							</span>
							<span className="agent-copy">
								<strong>{agent.displayName}</strong>
								<small>
									{agent.registered
										? "Already connected"
										: agent.detected
											? (agent.version ?? "Local data found")
											: agent.inspection === "failed"
												? "Couldn't inspect"
												: "Not installed"}
								</small>
							</span>
							{agent.registered ? <Check className="row-check" /> : null}
						</label>
					);
				})}
			</div>

			<footer className="actions">
				<button
					className="button primary"
					type="button"
					onClick={shouldConnect ? onConnect : onOpenDashboard}
				>
					{selected.size > 0
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

function DashboardApp({ bridge }: { bridge: ClawdiDesktopShellBridge }) {
	const [state, setState] = useState<DesktopDashboardState | null>(null);
	const [selected, setSelected] = useState<DesktopLocalSessionDetail | null>(null);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setFailure(null);
		try {
			setState(await bridge.getDashboardState());
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Couldn't read local sessions.");
		} finally {
			setLoading(false);
		}
	}, [bridge]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const sessions = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		if (!needle) return state?.sessions ?? [];
		return (state?.sessions ?? []).filter((session) =>
			[session.summary, session.project, session.agentName, session.model, session.id]
				.filter((value): value is string => Boolean(value))
				.some((value) => value.toLocaleLowerCase().includes(needle)),
		);
	}, [query, state]);

	async function openSession(session: DesktopLocalSession) {
		setDetailLoading(true);
		setFailure(null);
		try {
			setSelected(await bridge.readLocalSession(session.agent, session.id));
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Couldn't read the local session.");
		} finally {
			setDetailLoading(false);
		}
	}

	async function openConnectWizard() {
		setFailure(null);
		try {
			await bridge.openConnectWizard();
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "Couldn't open Connect Agent.");
		}
	}

	const syncReady = state?.auth.authenticated === true && state.daemon.running;
	return (
		<main className="dashboard-shell">
			<aside className="dashboard-sidebar">
				<div className="dashboard-brand">
					<span className="brand-mark" aria-hidden="true">
						<TerminalSquare />
					</span>
					<div>
						<h1>Clawdi</h1>
						<p>Desktop</p>
					</div>
				</div>
				<nav className="dashboard-nav" aria-label="Desktop navigation">
					<button className="dashboard-nav-item active" type="button">
						<MessageSquare /> Sessions
					</button>
				</nav>
				<div className="dashboard-sidebar-footer">
					<div className={`sync-state${syncReady ? " ready" : ""}`}>
						{syncReady ? <Cloud /> : <CloudOff />}
						<div>
							<strong>{syncReady ? "Cloud sync on" : "Local data available"}</strong>
							<small>
								{syncReady
									? (state?.auth.user?.email ?? "Background sync is running")
									: "Sign-in is optional for local history"}
							</small>
						</div>
					</div>
					<button
						className="button secondary dashboard-connect"
						type="button"
						onClick={() => void openConnectWizard()}
					>
						<TerminalSquare /> Connect Agent
					</button>
				</div>
			</aside>

			<section className="dashboard-main">
				<header className="dashboard-toolbar">
					<div>
						<h2>{selected ? selected.session.summary || "Session" : "Local sessions"}</h2>
						<p>
							{selected
								? `${selected.session.agentName} · ${displayProject(selected.session.project)}`
								: "Read directly from the Agents on this Mac"}
						</p>
					</div>
					<div className="toolbar-actions">
						<span className="local-badge">
							<HardDrive /> On this Mac
						</span>
						<button
							className="icon-button"
							type="button"
							title="Refresh local sessions"
							aria-label="Refresh local sessions"
							disabled={loading}
							onClick={() => void refresh()}
						>
							<RefreshCw className={loading ? "spin" : undefined} />
						</button>
					</div>
				</header>

				{failure ? (
					<div className="dashboard-alert" role="alert">
						<TriangleAlert />
						<span>{failure}</span>
					</div>
				) : null}

				{selected ? (
					<SessionDetail detail={selected} onBack={() => setSelected(null)} />
				) : (
					<div className="sessions-view">
						<label className="dashboard-search">
							<Search aria-hidden="true" />
							<input
								type="search"
								placeholder="Search local sessions"
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</label>
						{loading || detailLoading ? (
							<Centered icon={<LoaderCircle className="spin" />} title="Reading this Mac" />
						) : sessions.length === 0 ? (
							<Centered
								icon={<MessageSquare />}
								title={query ? "No matching sessions" : "No local sessions yet"}
								description={
									query
										? "Try a different project, Agent, model, or summary."
										: "Connect an Agent or start a coding session. History will appear here without uploading first."
								}
							/>
						) : (
							<div className="session-list">
								{sessions.map((session) => (
									<button
										className="session-row"
										type="button"
										key={`${session.agent}:${session.id}`}
										onClick={() => void openSession(session)}
									>
										<span className="session-copy">
											<strong>{session.summary || displayProject(session.project)}</strong>
											<small>{displayProject(session.project)}</small>
										</span>
										<span>{session.agentName}</span>
										<span>{session.messageCount} messages</span>
										<time dateTime={session.startedAt}>{relativeDate(session.startedAt)}</time>
										<ArrowRight />
									</button>
								))}
							</div>
						)}
					</div>
				)}
			</section>
		</main>
	);
}

function SessionDetail({ detail, onBack }: { detail: DesktopLocalSessionDetail; onBack(): void }) {
	return (
		<div className="session-detail">
			<button className="back-button" type="button" onClick={onBack}>
				<ArrowLeft /> All sessions
			</button>
			<div className="session-meta">
				<span>{detail.session.agentName}</span>
				<span>{detail.session.model ?? "Unknown model"}</span>
				<span>{relativeDate(detail.session.startedAt)}</span>
			</div>
			<div className="message-list">
				{detail.messages.map((message, index) => (
					<article
						className={`message ${message.role}`}
						key={`${message.timestamp ?? "message"}-${index}`}
					>
						<header>
							<strong>{message.role === "user" ? "You" : "Assistant"}</strong>
							{message.timestamp ? (
								<time dateTime={message.timestamp}>{relativeDate(message.timestamp)}</time>
							) : null}
						</header>
						<p>{message.content}</p>
					</article>
				))}
			</div>
		</div>
	);
}

function displayProject(project: string | null): string {
	if (!project) return "No project";
	const parts = project.split("/").filter(Boolean);
	return parts.at(-1) ?? project;
}

function relativeDate(raw: string): string {
	const date = new Date(raw);
	const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
	return formatter.format(Math.round(hours / 24), "day");
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
const surface = new URLSearchParams(window.location.search).get("surface");
if (surface === "dashboard" && window.clawdiDesktop) {
	document.title = "Clawdi";
	createRoot(root).render(<DashboardApp bridge={window.clawdiDesktop} />);
} else if (window.clawdiConnect) {
	createRoot(root).render(<ConnectApp bridge={window.clawdiConnect} />);
} else {
	throw new Error("Clawdi renderer bridge is unavailable.");
}
