"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AccountAliasField } from "@/components/connectors/account-alias-field";
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
import { unwrap, useApi } from "@/lib/api";
import { useAuthFields } from "@/lib/connectors-data";
import { shouldBlockQueryError } from "@/lib/query-state";
import { useSensitiveAction } from "@/lib/use-sensitive-action";
import { buildCredentialPayload, getVisibleCredentialFields } from "./credentials-dialog.logic";

/**
 * Credential fields load on open; sensitive submissions keep plaintext out of MutationCache.
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
	const formId = useId();
	const fields = useAuthFields(appName, { enabled: open });
	const api = useApi();
	const queryClient = useQueryClient();
	const submit = useSensitiveAction(
		async (credentials: Record<string, string>, alias: string): Promise<void> => {
			unwrap(
				await api.POST("/v1/connectors/{app_name}/connect-credentials", {
					params: { path: { app_name: appName } },
					body: { credentials, ...(alias ? { alias } : {}) },
				}),
			);
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/connectors"] });
		},
	);
	const [alias, setAlias] = useState("");
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
		if (!open) return;
		openGenRef.current += 1;
		setValues({});
		setAlias("");
		setSubmitError(null);
		return () => {
			openGenRef.current += 1;
		};
	}, [open]);

	const allFields = fields.data?.expected_input_fields ?? [];
	const visibleFields = getVisibleCredentialFields(allFields);
	const canSubmit =
		visibleFields.length > 0 &&
		visibleFields.filter((f) => f.required).every((f) => values[f.name]?.trim());

	async function handleSubmit() {
		if (!canSubmit || inflightSubmitRef.current) return;
		inflightSubmitRef.current = true;
		const gen = openGenRef.current;
		setSubmitError(null);
		try {
			const credentials = buildCredentialPayload(allFields, values);
			await submit.execute(credentials, alias.trim());
			// Drop the result if the dialog has been reopened — toasts
			// and `onOpenChange(false)` should target the session that
			// initiated the mutation, not whatever the user is doing now.
			if (gen !== openGenRef.current) return;
			setValues({});
			toast.success(`${displayName} connected`);
			onOpenChange(false);
		} catch {
			if (gen !== openGenRef.current) return;
			setSubmitError(
				"The account couldn’t be connected. Try again. If the problem persists, contact support.",
			);
		} finally {
			inflightSubmitRef.current = false;
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) openGenRef.current += 1;
				onOpenChange(nextOpen);
			}}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setValues({});
					setSubmitError(null);
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Connect {displayName}</DialogTitle>
					<DialogDescription>
						Enter the credentials this app expects. They are stored in Composio and used when
						connector tools run.
					</DialogDescription>
				</DialogHeader>

				<DialogBody>
					{fields.isLoading ? (
						<div className="flex items-center justify-center py-6">
							<Spinner className="size-5 text-muted-foreground" />
						</div>
					) : shouldBlockQueryError(fields.error, fields.data) ? (
						<ApiErrorPanel
							error={fields.error}
							onRetry={() => {
								void fields.refetch();
							}}
							title="Couldn't load credential fields"
						/>
					) : visibleFields.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							This connector doesn't need any credentials configured here. Try OAuth from the
							connector page.
						</p>
					) : (
						<form
							id={formId}
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
											name={f.name}
											type={f.is_secret ? "password" : "text"}
											value={values[f.name] ?? ""}
											onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
											disabled={submit.isPending}
											autoComplete="off"
											required={f.required}
											spellCheck={false}
										/>
										{f.description ? (
											<p className="text-xs text-muted-foreground">{f.description}</p>
										) : null}
									</div>
								);
							})}
							<AccountAliasField value={alias} onChange={setAlias} disabled={submit.isPending} />
							{submitError ? (
								<p role="alert" className="text-sm text-destructive">
									{submitError}
								</p>
							) : null}
						</form>
					)}
				</DialogBody>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							openGenRef.current += 1;
							onOpenChange(false);
						}}
					>
						Cancel
					</Button>
					<Button type="submit" form={formId} disabled={!canSubmit || submit.isPending}>
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
