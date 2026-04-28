"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useAuthFields, useConnectCredentials } from "@/lib/connectors-data";
import { errorMessage } from "@/lib/utils";

/**
 * API-key / credentials connect form.
 *
 * Connectors split into two flows server-side: OAuth (handled by the
 * detail page's existing `window.open(connect_url)`) and credentials
 * (this dialog). The dialog fetches the field schema lazily on open
 * so the user pays no cost for OAuth-only deployments. All hosted vs
 * OSS branching is encapsulated in `useAuthFields` /
 * `useConnectCredentials` from `@/lib/connectors-data`.
 */
export function ConnectorCredentialsDialog({
	open,
	onOpenChange,
	appName,
	displayName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	appName: string;
	displayName: string;
}) {
	const fields = useAuthFields(appName, { enabled: open });
	const submit = useConnectCredentials();
	const [values, setValues] = useState<Record<string, string>>({});
	const [submitError, setSubmitError] = useState<string | null>(null);

	// Generation counter bumped on EVERY open transition (open→close
	// AND close→open). Each `handleSubmit` captures the generation it
	// ran under and ignores its own resolution if `gen !==
	// openGenRef.current` — meaning the dialog has transitioned since
	// the mutation started. We must bump on close too: if we only
	// bumped on open, a close-during-pending → rejection → reopen
	// sequence would leave `gen` matching (close didn't bump), so the
	// stale catch would write `submitError`, then the reopen effect
	// would reset it, then the user would see the stale error if the
	// rejection arrived AFTER the reopen effect committed.
	const openGenRef = useRef(0);
	// Synchronous single-flight guard. `submit.isPending` is the
	// post-render TanStack Query state, so two rapid Connect clicks
	// fired before the next commit would both pass the
	// `if (… || submit.isPending) return` check below and queue
	// duplicate POSTs. The ref flips before mutation queues — same
	// pattern as the OAuth/disconnect handlers in the detail page.
	const inflightSubmitRef = useRef(false);
	useEffect(() => {
		openGenRef.current += 1;
		setValues({});
		setSubmitError(null);
	}, [open]);

	const visibleFields = (fields.data?.expected_input_fields ?? []).filter(
		(f) => f.expected_from_customer !== false,
	);
	const canSubmit =
		visibleFields.length > 0 &&
		visibleFields.filter((f) => f.required).every((f) => values[f.name]?.trim());

	async function handleSubmit() {
		if (!canSubmit || inflightSubmitRef.current) return;
		inflightSubmitRef.current = true;
		const gen = openGenRef.current;
		setSubmitError(null);
		try {
			const credentials = Object.fromEntries(
				visibleFields.flatMap((f): [string, string][] => {
					const value = values[f.name];
					return value?.trim() ? [[f.name, value]] : [];
				}),
			);
			await submit.mutateAsync({ appName, credentials });
			// Drop the result if the dialog has been reopened — toasts
			// and `onOpenChange(false)` should target the session that
			// initiated the mutation, not whatever the user is doing now.
			if (gen !== openGenRef.current) return;
			toast.success(`${displayName} connected`);
			onOpenChange(false);
		} catch (e) {
			if (gen !== openGenRef.current) return;
			setSubmitError(errorMessage(e));
		} finally {
			inflightSubmitRef.current = false;
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Connect {displayName}</DialogTitle>
					<DialogDescription>
						Enter the credentials this app expects. Composio validates them immediately — you'll see
						an error here if anything's wrong.
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					{fields.isLoading ? (
						<div className="flex items-center justify-center py-6">
							<Spinner className="size-5 text-muted-foreground" />
						</div>
					) : fields.error ? (
						<p role="alert" className="text-sm text-destructive">
							{errorMessage(fields.error)}
						</p>
					) : visibleFields.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							This connector doesn't need any credentials configured here. Try OAuth from the
							connector page.
						</p>
					) : (
						<form
							className="flex flex-col gap-3"
							onSubmit={(e) => {
								e.preventDefault();
								if (canSubmit && !submit.isPending) void handleSubmit();
							}}
						>
							{visibleFields.map((f) => {
								const id = `cred-${f.name}`;
								return (
									<div key={f.name} className="flex flex-col gap-1.5">
										<Label htmlFor={id}>
											{f.display_name || f.name}
											{f.required ? <span className="ml-0.5 text-destructive">*</span> : null}
										</Label>
										<Input
											id={id}
											type={f.is_secret ? "password" : "text"}
											value={values[f.name] ?? ""}
											onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
											autoComplete={f.is_secret ? "off" : undefined}
											required={f.required}
										/>
										{f.description ? (
											<p className="text-xs text-muted-foreground">{f.description}</p>
										) : null}
									</div>
								);
							})}
							{submitError ? (
								<p role="alert" className="text-sm text-destructive">
									{submitError}
								</p>
							) : null}
						</form>
					)}
				</DialogBody>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={!canSubmit || submit.isPending}>
						{submit.isPending ? <Spinner className="size-3.5" /> : null}
						Connect
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function DialogBody({ children }: { children: ReactNode }) {
	return <div className="py-2">{children}</div>;
}
