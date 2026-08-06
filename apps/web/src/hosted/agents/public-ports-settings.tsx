"use client";

import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useUnsavedNavigationState } from "@/components/unsaved-navigation-state";
import { useUpdateDeployment } from "@/hosted/agents/deployment-hooks";
import {
	createPublicPortDraftState,
	projectPublicHttpPorts,
	publicEndpointAvailability,
	publicEndpointsArePending,
	publicPortDraftIsDirty,
	publicPortsUpdate,
	reconcilePublicPortDraft,
	validatePublicPortDraft,
} from "@/hosted/agents/public-ports-settings.logic";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { deploymentStatusFromResource } from "@/hosted/deployment-status";

export function PublicEndpointList({
	ports,
	endpoints,
	pending,
}: {
	ports: readonly number[];
	endpoints: HostedDeployment["public_endpoints"];
	pending: boolean;
}) {
	return (
		<div className="flex flex-col gap-2">
			<h4 className="text-xs font-medium">Available URLs</h4>
			{ports.length === 0 ? (
				<p className="text-sm text-muted-foreground">No public HTTP ports configured.</p>
			) : (
				<div className="overflow-hidden rounded-lg border">
					{ports.map((port, index) => {
						const availability = publicEndpointAvailability(port, endpoints, pending);
						return (
							<div
								key={port}
								data-public-port={port}
								data-public-port-state={availability.kind}
								className={`grid gap-1 px-3 py-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-center sm:gap-3 ${index === 0 ? "" : "border-t"}`}
							>
								<div className="text-sm font-medium">Port {port}</div>
								{availability.kind === "available" ? (
									<a
										href={availability.url}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex min-w-0 items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
									>
										<span className="truncate">{availability.url}</span>
										<ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
										<span className="sr-only">Open in new tab</span>
									</a>
								) : availability.kind === "pending" ? (
									<span role="status" className="text-sm text-muted-foreground">
										Configuring…
									</span>
								) : (
									<span className="text-sm text-muted-foreground">Not available yet</span>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

export function PublicPortsSettingsSection({ deployment }: { deployment: HostedDeployment }) {
	const formId = useId();
	const nextDraftRowId = useRef(0);
	const authoritativePorts = useMemo(
		() => projectPublicHttpPorts(deployment),
		[deployment.resource.spec.ports],
	);
	const [draftState, setDraftState] = useState(() =>
		createPublicPortDraftState(authoritativePorts, deployment.resource.id),
	);
	useEffect(() => {
		setDraftState((current) =>
			reconcilePublicPortDraft(current, authoritativePorts, deployment.resource.id),
		);
	}, [authoritativePorts, deployment.resource.id]);

	const updateDeployment = useUpdateDeployment();
	const updateInProgress =
		deploymentStatusFromResource(deployment.resource.status).kind === "updating";
	const values = draftState.rows.map((row) => row.value);
	const validation = validatePublicPortDraft(values);
	const dirty = publicPortDraftIsDirty(values, authoritativePorts);
	const busy = updateDeployment.isPending || updateInProgress;
	const endpointsPending = publicEndpointsArePending(deployment, updateDeployment.isPending);
	useUnsavedNavigationState({ dirty, busy: updateDeployment.isPending });

	return (
		<section
			data-hosted="true"
			aria-labelledby={`${formId}-title`}
			className="flex max-w-2xl flex-col gap-4"
		>
			<div className="flex flex-col gap-1.5">
				<h3 id={`${formId}-title`} className="text-sm font-medium">
					Public HTTP ports
				</h3>
				<p className="text-sm leading-5 text-muted-foreground">
					Expose HTTP services running on this agent to the public internet.
				</p>
			</div>

			{draftState.rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">No public HTTP ports configured.</p>
			) : (
				<div className="flex flex-col gap-2.5">
					{draftState.rows.map((row, index) => {
						const inputId = `${formId}-${row.id}`;
						const errorId = `${inputId}-error`;
						const error = validation.errors[index];
						return (
							<div key={row.id} className="flex items-start gap-2">
								<div className="flex w-full max-w-xs flex-col gap-1.5">
									<Label htmlFor={inputId} className="sr-only">
										HTTP port {index + 1}
									</Label>
									<Input
										id={inputId}
										type="text"
										inputMode="numeric"
										value={row.value}
										disabled={busy}
										aria-invalid={error ? true : undefined}
										aria-describedby={error ? errorId : undefined}
										onChange={(event) =>
											setDraftState((current) => ({
												...current,
												rows: current.rows.map((item) =>
													item.id === row.id ? { ...item, value: event.target.value } : item,
												),
											}))
										}
									/>
									{error ? (
										<p id={errorId} className="text-sm text-destructive">
											{error}
										</p>
									) : null}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									disabled={busy}
									aria-label={`Remove HTTP port ${index + 1}`}
									onClick={() =>
										setDraftState((current) => ({
											...current,
											rows: current.rows.filter((item) => item.id !== row.id),
										}))
									}
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
						);
					})}
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => {
						const id = `draft-${nextDraftRowId.current}`;
						nextDraftRowId.current += 1;
						setDraftState((current) => ({
							...current,
							rows: [...current.rows, { id, value: "" }],
						}));
					}}
				>
					<Plus className="size-3.5" />
					Add port
				</Button>
				<Button
					type="button"
					size="sm"
					disabled={!dirty || validation.ports === null || busy}
					onClick={() => {
						if (validation.ports === null) return;
						updateDeployment.mutate({
							id: deployment.resource.id,
							update: publicPortsUpdate(validation.ports),
						});
					}}
				>
					{updateDeployment.isPending ? <Spinner className="size-3.5" /> : null}
					{busy ? "Applying…" : "Save changes"}
				</Button>
			</div>

			<PublicEndpointList
				ports={authoritativePorts}
				endpoints={deployment.public_endpoints}
				pending={endpointsPending}
			/>
		</section>
	);
}
