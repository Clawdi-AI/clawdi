"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
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
import {
	type CloudShapedAuthFields,
	useHostedAuthFields,
	useHostedConnectCredentialsMutation,
} from "@/hosted/use-hosted-connectors";
import { unwrap, useApi } from "@/lib/api";
import { IS_HOSTED } from "@/lib/hosted";
import { errorMessage } from "@/lib/utils";

/**
 * API-key / credentials connect form.
 *
 * Connectors split into two flows server-side: OAuth (handled by the
 * detail page's existing `window.open(connect_url)`) and credentials
 * (this dialog). The dialog fetches the field schema lazily on open
 * so the user pays no cost for OAuth-only deployments, and submits
 * via the same source-aware adapter pattern as the rest of the
 * connectors page — `IS_HOSTED` picks the hosted vs cloud-api path,
 * UI is identical.
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
	const fields = useAuthFieldsForUI({ appName, enabled: open });
	const submit = useConnectCredentialsForUI();
	const [values, setValues] = useState<Record<string, string>>({});
	const [submitError, setSubmitError] = useState<string | null>(null);

	// Reset the form whenever the dialog closes so reopening it on a
	// different app doesn't carry over a previous submission's input
	// or a stale error message.
	useEffect(() => {
		if (!open) {
			setValues({});
			setSubmitError(null);
		}
	}, [open]);

	const visibleFields = (fields.data?.expected_input_fields ?? []).filter(
		(f) => f.expected_from_customer !== false,
	);
	const canSubmit =
		visibleFields.length > 0 &&
		visibleFields.filter((f) => f.required).every((f) => values[f.name]?.trim());

	async function handleSubmit() {
		// Defense in depth: the button + form `disabled` props gate this
		// path, but a fast double-click or programmatic call could still
		// land two mutations in flight if the disabled flag hasn't yet
		// propagated to the click handler closure. Bail explicitly.
		if (!canSubmit || submit.isPending) return;
		setSubmitError(null);
		try {
			await submit.mutateAsync({ appName, credentials: values });
			toast.success(`${displayName} connected`);
			onOpenChange(false);
		} catch (e) {
			setSubmitError(errorMessage(e));
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
						<p className="text-sm text-destructive">{errorMessage(fields.error)}</p>
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
							{submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}
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

// ──────────────────────────────────────────────────────────────────
// Source adapters — hosted users hit clawdi.ai via the hosted hooks;
// OSS / self-host users hit cloud-api directly. Both paths return the
// same `CloudShapedAuthFields` so the dialog stays branch-free.

function useAuthFieldsForUI({ appName, enabled }: { appName: string; enabled: boolean }) {
	const api = useApi();
	const cloud = useQuery({
		queryKey: ["auth-fields", appName],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/connectors/{app_name}/auth-fields", {
					params: { path: { app_name: appName } },
				}),
			),
		enabled: enabled && !IS_HOSTED,
	});
	const hosted = useHostedAuthFields({ appName, enabled: enabled && IS_HOSTED });
	const data: CloudShapedAuthFields | undefined = IS_HOSTED ? hosted.data : cloud.data;
	const isLoading = IS_HOSTED ? hosted.isLoading : cloud.isLoading;
	const error = IS_HOSTED ? hosted.error : cloud.error;
	return { data, isLoading, error };
}

function useConnectCredentialsForUI() {
	const api = useApi();
	const qc = useQueryClient();
	const cloud = useMutation({
		mutationFn: async ({
			appName,
			credentials,
		}: {
			appName: string;
			credentials: Record<string, string>;
		}) =>
			unwrap(
				await api.POST("/api/connectors/{app_name}/connect-credentials", {
					params: { path: { app_name: appName } },
					body: { credentials },
				}),
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
	});
	const hosted = useHostedConnectCredentialsMutation();
	return IS_HOSTED ? hosted : cloud;
}
