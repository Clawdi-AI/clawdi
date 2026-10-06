import { cloneElement, type ComponentProps, useEffect, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { RichConfirmAction } from "@/components/ui/rich-confirm-action";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
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
			if (state !== "active") confirmation.close();
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
