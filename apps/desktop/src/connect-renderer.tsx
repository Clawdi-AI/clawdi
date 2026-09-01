import type {
	ClawdiDesktopConnectBridge,
	ClawdiDesktopShellBridge,
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopDetectedAgent,
} from "@clawdi/shared/desktop";
import {
	ArrowRight,
	Check,
	CircleCheckBig,
	FolderInput,
	LoaderCircle,
	RefreshCw,
	ShieldCheck,
	TerminalSquare,
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
				<button
					className="icon-button"
					type="button"
					onClick={onRefresh}
					title="Scan again"
					aria-label="Scan again"
				>
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
							<AgentBrandIcon type={agent.type} />
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

function DashboardFailureApp({ bridge }: { bridge: ClawdiDesktopShellBridge }) {
	const [pending, setPending] = useState<"retry" | "connect" | null>(null);
	const [failed, setFailed] = useState(false);

	async function run(action: "retry" | "connect") {
		setPending(action);
		setFailed(false);
		try {
			await (action === "retry" ? bridge.retryDashboard() : bridge.openConnectWizard());
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
						title={failed ? "Couldn't reconnect" : "Clawdi is offline"}
						description={
							failed
								? "Try again, or open Connect Agent to check the local connection."
								: "The app is installed, but your account session couldn't be refreshed. Check your connection and try again."
						}
					/>
					<footer className="actions failure-actions">
						<button
							className="button secondary"
							type="button"
							disabled={pending !== null}
							onClick={() => void run("connect")}
						>
							<TerminalSquare /> Connect Agent
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
const surface = new URLSearchParams(window.location.search).get("surface");
if (surface === "dashboard-failure" && window.clawdiDesktop) {
	document.title = "Clawdi is offline";
	createRoot(root).render(<DashboardFailureApp bridge={window.clawdiDesktop} />);
} else if (window.clawdiConnect) {
	createRoot(root).render(<ConnectApp bridge={window.clawdiConnect} />);
} else {
	throw new Error("Clawdi renderer bridge is unavailable.");
}
