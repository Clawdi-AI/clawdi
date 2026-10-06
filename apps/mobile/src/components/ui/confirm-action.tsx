import { confirmActionClasses } from "@clawdi/shared/ui";
import { BottomSheet } from "@expo/ui/community/bottom-sheet";
import { useIsFocused } from "expo-router/react-navigation";
import {
	type ComponentProps,
	cloneElement,
	type ReactElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { Alert, AppState, type PressableProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	AlertDialogAction,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Content } from "@/components/ui/content";
import { Spinner } from "@/components/ui/feedback";
import { WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { createActionGate } from "@/platform/auth/action-gate";
import { createNativeConfirmation } from "@/platform/native-confirmation";

type Props = ComponentProps<typeof RichConfirmAction>;
/** Strings use the system alert. Rich content uses a native sheet. */
export function ConfirmAction(props: Props) {
	return typeof props.description === "string" && !props.secondaryAction ? (
		<NativeConfirmAction {...props} description={props.description} />
	) : (
		<RichConfirmAction {...props} />
	);
}
function NativeConfirmAction({
	children,
	title,
	description,
	confirmLabel,
	cancelLabel,
	destructive,
	onConfirm,
	open: controlledOpen,
	onOpenChange,
}: Props & { description: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const focused = useIsFocused();
	const [internalOpen, setInternalOpen] = useState(false);
	const open = controlledOpen ?? internalOpen;
	const latest = useRef({ onConfirm, onOpenChange });
	latest.current = { onConfirm, onOpenChange };
	const [confirmation] = useState(() =>
		createNativeConfirmation((request, confirm, cancel, failed) => {
			Alert.alert(
				request.title,
				`${request.description}${failed ? `\n\n${t("composite.genericError")}` : ""}`,
				[
					{ text: request.cancelLabel, style: "cancel", onPress: cancel },
					{
						text: request.confirmLabel,
						style: request.destructive ? "destructive" : "default",
						onPress: confirm,
					},
				],
				{ cancelable: false },
			);
		}),
	);
	useEffect(() => {
		if (!open || !focused || !scope.isReady) return;
		confirmation.open({
			title,
			description,
			confirmLabel: confirmLabel ?? t("composite.confirm"),
			cancelLabel: cancelLabel ?? t("composite.cancel"),
			destructive,
			onConfirm: () => {
				if (scope.isCurrent() && AppState.currentState === "active")
					return latest.current.onConfirm();
			},
			onClose: () => {
				setInternalOpen(false);
				latest.current.onOpenChange?.(false);
			},
		});
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				confirmation.close();
				setInternalOpen(false);
				latest.current.onOpenChange?.(false);
			}
		});
		return () => {
			listener.remove();
			confirmation.close();
		};
	}, [
		open,
		focused,
		scope.identity,
		scope.generation,
		scope.isReady,
		confirmation,
		title,
		description,
		confirmLabel,
		cancelLabel,
		destructive,
		t,
	]);
	return children
		? cloneElement(children, {
				onPress: (event) => {
					children.props.onPress?.(event);
					setInternalOpen(true);
					latest.current.onOpenChange?.(true);
				},
			})
		: null;
}

/** Web confirmation lifecycle on a native Modal: lock duplicate presses, retain on failure. */
export function RichConfirmAction({
	children,
	title,
	description,
	confirmLabel,
	cancelLabel,
	confirmClassName,
	secondaryAction,
	destructive = false,
	onConfirm,
	open: controlledOpen,
	onOpenChange,
}: {
	children?: ReactElement<PressableProps>;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	title: string;
	description: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	confirmClassName?: string;
	secondaryAction?: { label: string; onAction: () => unknown };
	destructive?: boolean;
	onConfirm: () => unknown;
}) {
	const t = useI18n(),
		[internalOpen, setInternalOpen] = useState(false),
		[pendingAction, setPendingAction] = useState<"confirm" | "secondary" | null>(null),
		[error, setError] = useState<unknown>(null);
	const locked = useRef(false);
	const gate = useRef(createActionGate());
	const open = controlledOpen ?? internalOpen;
	const background = useCSSVariable("--color-popover");
	useEffect(() => {
		if (open) {
			gate.current.activate();
		} else {
			gate.current.deactivate();
			locked.current = false;
			setPendingAction(null);
		}
		return () => gate.current.deactivate();
	}, [open]);
	const setOpen = (next: boolean) => {
		if (controlledOpen === undefined) setInternalOpen(next);
		if (next) setError(null);
		onOpenChange?.(next);
	};
	const runAction = async (action: "confirm" | "secondary", callback: () => unknown) => {
		const lease = gate.current.acquire();
		if (!lease) return;
		locked.current = true;
		setPendingAction(action);
		setError(null);
		try {
			await callback();
			if (lease.isCurrent()) setOpen(false);
		} catch (failure) {
			if (lease.isCurrent()) {
				setError(failure);
				setPendingAction(null);
				locked.current = false;
			}
			lease.release();
		}
	};
	return (
		<>
			{children
				? cloneElement(children, {
						onPress: (event) => {
							children.props.onPress?.(event);
							setOpen(true);
						},
					})
				: null}
			<BottomSheet
				index={open ? 0 : -1}
				enablePanDownToClose={!locked.current}
				onClose={() => {
					if (!locked.current) setOpen(false);
				}}
				backgroundStyle={{
					backgroundColor: typeof background === "string" ? background : undefined,
				}}
			>
				<WebView recipe="gap-6 p-6">
					<AlertDialogHeader>
						<AlertDialogTitle>{title}</AlertDialogTitle>
						<AlertDialogDescription>{description}</AlertDialogDescription>
					</AlertDialogHeader>
					{error ? <ApiErrorPanel error={error} /> : null}
					<AlertDialogFooter>
						<Button
							variant="outline"
							disabled={pendingAction !== null}
							onPress={() => setOpen(false)}
						>
							<Content>{cancelLabel ?? t("composite.cancel")}</Content>
						</Button>
						{secondaryAction ? (
							<AlertDialogAction
								variant="outline"
								disabled={pendingAction !== null}
								className={webView(confirmActionClasses.action)}
								onPress={() => void runAction("secondary", secondaryAction.onAction)}
							>
								{pendingAction === "secondary" ? <Spinner /> : null}
								<Content>{secondaryAction.label}</Content>
							</AlertDialogAction>
						) : null}
						<AlertDialogAction
							// Web forms with a custom action recipe style the default Action.
							// A destructive variant would keep its dark muted background here.
							variant={destructive && !confirmClassName ? "destructive" : "default"}
							disabled={pendingAction !== null}
							className={`${webView(confirmActionClasses.action)} ${webBoth(confirmClassName ?? "")}`}
							onPress={() => void runAction("confirm", onConfirm)}
						>
							{pendingAction === "confirm" ? <Spinner /> : null}
							<Content>{confirmLabel ?? t("composite.confirm")}</Content>
						</AlertDialogAction>
					</AlertDialogFooter>
				</WebView>
			</BottomSheet>
		</>
	);
}
