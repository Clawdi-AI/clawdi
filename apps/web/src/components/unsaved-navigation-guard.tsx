"use client";

import { type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function UnsavedNavigationGuard({
	dirty,
	busy,
	description = "Your edits will return to the last values saved on the server.",
	shouldBlockFn,
}: {
	dirty: boolean;
	busy: boolean;
	description?: string;
	shouldBlockFn?: ShouldBlockFn;
}) {
	const riskRef = useRef(false);
	riskRef.current = dirty || busy;
	const shouldBlock: ShouldBlockFn = useCallback(
		(args) => riskRef.current && (shouldBlockFn?.(args) ?? true),
		[shouldBlockFn],
	);
	const shouldBlockDocumentExit = useCallback(() => riskRef.current, []);
	const blocker = useBlocker({
		shouldBlockFn: shouldBlock,
		enableBeforeUnload: shouldBlockDocumentExit,
		withResolver: true,
	});

	useEffect(() => {
		if (blocker.status === "blocked" && !dirty && !busy) blocker.proceed();
	}, [blocker, busy, dirty]);

	return (
		<AlertDialog
			open={blocker.status === "blocked"}
			onOpenChange={(open) => {
				if (!open && blocker.status === "blocked") blocker.reset();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{busy ? "Save in progress" : "Discard unsaved changes?"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{busy ? "Wait for this save to finish before leaving." : description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Keep editing</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={busy}
						onClick={() => {
							if (blocker.status === "blocked") blocker.proceed();
						}}
					>
						Discard changes
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
