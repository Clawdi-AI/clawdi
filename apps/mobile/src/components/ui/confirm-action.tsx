import { confirmActionClasses } from "@clawdi/shared/ui";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import type { PressableProps } from "react-native";
import { createActionGate } from "@/platform/auth/action-gate";
import { useI18n } from "@/lib/i18n";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Content } from "@/components/ui/content";
import { Spinner } from "@/components/ui/feedback";
import { webBoth, webView } from "@/components/ui/web-layout";
/** Web confirmation lifecycle on a native Modal: lock duplicate presses, retain on failure. */
export function ConfirmAction({
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
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!locked.current) setOpen(next);
			}}
		>
			{children ? <AlertDialogTrigger render={children} /> : null}
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{error ? <ApiErrorPanel error={error} /> : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pendingAction !== null}>
						<Content>{cancelLabel ?? t("composite.cancel")}</Content>
					</AlertDialogCancel>
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
			</AlertDialogContent>
		</AlertDialog>
	);
}
