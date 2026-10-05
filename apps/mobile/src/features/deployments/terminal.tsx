import { deploymentTerminalIsAvailable, type HostedTerminalStatus } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform } from "react-native";
import { useUniwind } from "uniwind";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ActionButton as NativeButton } from "../../ui/agents/controls";
import { AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { BackButton } from "../cloud-inventory";
import TerminalDom from "./terminal-dom";

export function TerminalScreen({ deploymentId }: { deploymentId: string | undefined }) {
	const scope = useAccountScope();
	return (
		<Terminal
			key={`${scope.identity}:${scope.generation}:${deploymentId}`}
			deploymentId={deploymentId}
		/>
	);
}
function Terminal({ deploymentId }: { deploymentId: string | undefined }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { hosted, terminal } = useMobileApi();
	const { theme } = useUniwind();
	const active = useRef<AbortController | null>(null);
	const [connection, setConnection] = useState<AbortController | null>(null);
	const [status, setStatus] = useState<HostedTerminalStatus>("disconnected");
	const [input, setInput] = useState({ sequence: 0, value: "" });
	const [reconnectRequest, setReconnectRequest] = useState(0);
	const deployment = useQuery({
		queryKey: accountQueryKey(scope, "terminal-deployment", deploymentId),
		enabled: Boolean(hosted && deploymentId && scope.isReady),
		retry: false,
		queryFn: ({ signal }) =>
			read((s) => {
				if (!hosted || !deploymentId) throw new Error("Deployment unavailable");
				return hosted.getDeployment(deploymentId, s);
			}, signal),
	});
	const disconnect = useCallback(() => {
		active.current?.abort();
		active.current = null;
		setConnection(null);
		setStatus("disconnected");
	}, []);
	useFocusEffect(useCallback(() => () => disconnect(), [disconnect]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") disconnect();
		});
		return () => {
			listener.remove();
			active.current?.abort();
		};
	}, [disconnect]);
	const connect = () => {
		const visible = capture();
		if (
			active.current ||
			!terminal ||
			!deploymentId ||
			!scope.isCurrent() ||
			!visible() ||
			!deployment.data ||
			!deploymentTerminalIsAvailable(deployment.data)
		)
			return;
		const controller = new AbortController();
		active.current = controller;
		setStatus("connecting");
		setConnection(controller);
	};
	const requestWebsocketUrl = async () => {
		const visible = capture();
		const controller = connection;
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
	return (
		<ReadScreen>
			<KeyboardAvoidingView
				style={{ flex: 1 }}
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<AppView className="gap-2 p-3">
					<BackButton />
					<AppText accessibilityRole="header">{t("terminal.title")}</AppText>
					<AppText>{t(`terminal.${status}`)}</AppText>
					{!connection ? (
						<>
							<AppText>{t("terminal.warning")}</AppText>
							{!terminal || !deployment.data || !deploymentTerminalIsAvailable(deployment.data) ? (
								<AppText>{t("terminal.unavailable")}</AppText>
							) : null}
							<NativeButton
								label={t("terminal.connect")}
								disabled={
									!terminal || !deployment.data || !deploymentTerminalIsAvailable(deployment.data)
								}
								onPress={connect}
							/>
							{hosted && deploymentId ? (
								<NativeButton
									label={t("terminal.reload")}
									disabled={deployment.isFetching}
									onPress={() => {
										void deployment.refetch();
									}}
								/>
							) : null}
						</>
					) : (
						<>
							<NativeButton label={t("terminal.disconnect")} onPress={disconnect} />
							{status === "disconnected" ? (
								<NativeButton
									label={t("terminal.reconnect")}
									onPress={() => setReconnectRequest((value) => value + 1)}
								/>
							) : null}
							<AppView className="flex-row gap-2">
								{[
									{ label: "Esc", value: "\u001b" },
									{ label: "Tab", value: "\t" },
									{ label: "Ctrl+C", value: "\u0003" },
								].map((key) => (
									<AppView key={key.label} className="flex-1">
										<NativeButton
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
						</>
					)}
				</AppView>
				{connection ? (
					<TerminalDom
						dark={theme === "dark"}
						input={input}
						reconnectRequest={reconnectRequest}
						requestWebsocketUrl={requestWebsocketUrl}
						onStatusChange={async (value) => {
							if (
								["connecting", "connected", "reconnecting", "disconnected"].includes(value) &&
								connection === active.current &&
								!connection.signal.aborted &&
								scope.isCurrent()
							)
								setStatus(value);
						}}
						dom={{
							style: { flex: 1 },
							useExpoDOMWebView: true,
							unstable_useExpoModulesBridge: false,
							onContentProcessDidTerminate: disconnect,
							onRenderProcessGone: disconnect,
						}}
					/>
				) : null}
			</KeyboardAvoidingView>
		</ReadScreen>
	);
}
