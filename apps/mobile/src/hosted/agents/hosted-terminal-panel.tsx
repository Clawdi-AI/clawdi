import type { DeploymentRead, HostedTerminalStatus } from "@clawdi/shared/api";
import {
	agentSettingsCopy,
	agentSurfaceCopy,
	agentTerminalPresentation,
	terminalCopy,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router/react-navigation";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import SquareTerminal from "lucide-react-native/icons/square-terminal";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform } from "react-native";
import { useUniwind } from "uniwind";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ActionButton } from "@/components/dashboard/controls";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-badge";
import { Text as AppText } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { StartComputeAction } from "@/hosted/agents/start-compute-action";
import TerminalDom from "@/hosted/agents/terminal-dom";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const STATUS_TONES = {
	connecting: "warning",
	connected: "success",
	reconnecting: "warning",
	disconnected: "destructive",
} as const satisfies Record<HostedTerminalStatus, string>;

export function TerminalScreen({ deploymentId }: { deploymentId: string | undefined }) {
	const scope = useAccountScope();
	return (
		<Terminal
			key={`${scope.identity}:${scope.generation}:${deploymentId}`}
			deploymentId={deploymentId}
		/>
	);
}

/**
 * Web's TerminalTab: connects as soon as the agent can serve a terminal, with Web's status and
 * Retry/Reconnect. The app disconnects when the screen loses focus or goes to the background,
 * and connects again when it returns.
 */
function Terminal({ deploymentId }: { deploymentId: string | undefined }) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const cache = useQueryClient();
	const focused = useIsFocused();
	const { hosted, terminal } = useMobileApi();
	const { theme } = useUniwind();
	const active = useRef<AbortController | null>(null);
	const sessions = useRef(0);
	const [connection, setConnection] = useState<{ controller: AbortController; id: number } | null>(
		null,
	);
	const [connectRequest, setConnectRequest] = useState(0);
	const [status, setStatus] = useState<HostedTerminalStatus>("connecting");
	const [input, setInput] = useState({ sequence: 0, value: "" });
	const [reconnectRequest, setReconnectRequest] = useState(0);
	const [foreground, setForeground] = useState(AppState.currentState === "active");
	const deployment = useQuery<DeploymentRead>({
		queryKey: accountQueryKey(scope, "terminal-deployment", deploymentId),
		enabled: Boolean(hosted && deploymentId && scope.isReady),
		retry: false,
		// Like Web, a starting agent's terminal opens by itself once it can.
		refetchInterval: (query) =>
			focused &&
			query.state.data &&
			agentTerminalPresentation(query.state.data).state === "starting"
				? 10_000
				: false,
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !deploymentId) throw new Error("Deployment unavailable");
				return hosted.getDeployment(deploymentId, s);
			}, signal),
	});
	const view = deployment.data ? agentTerminalPresentation(deployment.data) : null;
	const ready = Boolean(terminal && deploymentId && view?.state === "available");
	const disconnect = useCallback(() => {
		active.current?.abort();
		active.current = null;
		setConnection(null);
		setStatus("disconnected");
	}, []);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) =>
			setForeground(state === "active"),
		);
		return () => listener.remove();
	}, []);
	// One session while visible and available; `connectRequest` lets Retry replace a lost one.
	useEffect(() => {
		if (!ready || !focused || !foreground || !scope.isCurrent()) return;
		const controller = new AbortController();
		active.current = controller;
		setStatus("connecting");
		setConnection({ controller, id: ++sessions.current });
		return () => {
			if (active.current === controller) disconnect();
			else controller.abort();
		};
	}, [ready, focused, foreground, scope, disconnect, connectRequest]);
	const requestWebsocketUrl = async () => {
		const visible = capture();
		const controller = connection?.controller;
		if (
			!controller ||
			controller !== active.current ||
			controller.signal.aborted ||
			!visible() ||
			!terminal ||
			!deploymentId
		)
			throw new Error("Terminal unavailable");
		const session = await read(
			(signal) => terminal.createSession(deploymentId, signal),
			controller.signal,
		);
		if (controller !== active.current || controller.signal.aborted || !visible())
			throw new Error("Terminal unavailable");
		return session.websocket_url;
	};
	const refresh = () =>
		cache.invalidateQueries({ queryKey: accountQueryKey(scope, "terminal-deployment") });
	const start = deployment.data && (view?.state === "stopped" || view?.state === "not_running") && (
		<StartComputeAction
			deployment={deployment.data}
			startLabel={view.state === "stopped" ? agentSettingsCopy.controls.start : undefined}
			blocked={deployment.isError}
			transitioning={Boolean(
				deployment.data.accepted_operation && !deployment.data.accepted_operation.done,
			)}
			onAccepted={refresh}
			onAbsent={refresh}
			onFunded={() => void refresh()}
		/>
	);
	return (
		<SafeAreaScreen>
			<NativeHeader title={terminalCopy.title} />
			{deployment.isError ? (
				<AppView className="px-4 pt-5">
					<ApiErrorPanel error={deployment.error} onRetry={() => void deployment.refetch()} />
				</AppView>
			) : !terminal ? (
				<EmptyState icon={SquareTerminal} className="flex-1" title={agentSurfaceCopy.unavailable} />
			) : view && view.state !== "available" ? (
				<EmptyState
					icon={view.state === "stopped" ? undefined : SquareTerminal}
					className="flex-1"
					title={view.title}
					description={view.description}
					action={start}
				/>
			) : (
				<KeyboardAvoidingView
					style={{ flex: 1 }}
					behavior={Platform.OS === "ios" ? "padding" : "height"}
				>
					{/* The page inset every other screen uses (dashboard page `px-4`, list `pt-5`). */}
					<AppView className="gap-3 px-4 pt-5 pb-3">
						<AppView className="flex-row items-center justify-between gap-3">
							{/* Web's TerminalStatusIndicator. */}
							<AppView className="flex-row items-center gap-2">
								<StatusDot status={STATUS_TONES[status]} className="size-2" />
								<AppText className="text-xs text-muted-foreground">
									{terminalCopy.status[status]}
								</AppText>
							</AppView>
							<ActionButton
								label={status === "disconnected" ? terminalCopy.retry : terminalCopy.reconnect}
								icon={<Icon as={RefreshCw} />}
								disabled={status === "connecting" || status === "reconnecting"}
								onPress={() =>
									connection
										? setReconnectRequest((value) => value + 1)
										: setConnectRequest((value) => value + 1)
								}
							/>
						</AppView>
						<AppView className="flex-row gap-2">
							{[
								{ label: "Esc", value: "\u001b" },
								{ label: "Tab", value: "\t" },
								{ label: "Ctrl+C", value: "\u0003" },
							].map((key) => (
								<AppView key={key.label} className="flex-1">
									<ActionButton
										label={key.label}
										disabled={status !== "connected"}
										onPress={() =>
											setInput((previous) => ({
												sequence: previous.sequence + 1,
												value: key.value,
											}))
										}
									/>
								</AppView>
							))}
						</AppView>
					</AppView>
					{connection ? (
						<TerminalDom
							key={connection.id}
							dark={theme === "dark"}
							input={input}
							reconnectRequest={reconnectRequest}
							requestWebsocketUrl={requestWebsocketUrl}
							onStatusChange={async (value) => {
								if (
									["connecting", "connected", "reconnecting", "disconnected"].includes(value) &&
									connection.controller === active.current &&
									!connection.controller.signal.aborted &&
									scope.isCurrent()
								)
									setStatus(value);
							}}
							dom={{
								style: { flex: 1 },
								onContentProcessDidTerminate: disconnect,
								onRenderProcessGone: disconnect,
							}}
						/>
					) : null}
				</KeyboardAvoidingView>
			)}
		</SafeAreaScreen>
	);
}
