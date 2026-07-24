"use client";

import { type ReactElement, type ReactNode, useRef, useState } from "react";
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
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function ConfirmAction({
	children,
	title,
	description,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	destructive = false,
	onConfirm,
}: {
	children: ReactElement;
	title: string;
	description: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
	/**
	 * May be sync or async (any return). When it returns a promise the dialog
	 * stays open with a spinner until it settles, then closes. Long-running
	 * background work should resolve this promise when the action is accepted.
	 */
	onConfirm: () => unknown;
}) {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	// Synchronous lock: `disabled` only takes effect on the next render, leaving
	// a sub-frame window where a fast double-click (or Enter repeat) could fire
	// the destructive action twice before React repaints.
	const locked = useRef(false);

	async function runConfirm() {
		if (locked.current) return;
		locked.current = true;
		setPending(true);
		try {
			await onConfirm();
			setOpen(false);
		} finally {
			setPending(false);
			locked.current = false;
		}
	}

	return (
		<AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
			<AlertDialogTrigger render={children} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription render={<div className="space-y-2" />}>
						{description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
					<AlertDialogAction
						// Keep the dialog open until the caller settles; accepted background work
						// closes here while status polling reflects its eventual outcome.
						onClick={(event) => {
							event.preventDefault();
							// runConfirm rejects when onConfirm does; the dialog already stays open
							// on reject and callers own their onError, so just swallow the
							// unhandled-rejection console noise without changing behavior.
							void runConfirm().catch(() => {});
						}}
						disabled={pending}
						className={cn(destructive && buttonVariants({ variant: "destructive" }))}
					>
						{pending ? <Spinner /> : null}
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
