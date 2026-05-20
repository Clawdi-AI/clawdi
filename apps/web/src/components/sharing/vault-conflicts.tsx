"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface VaultConflict {
	vault_slug: string;
	section: string;
	item_name: string;
}

export interface VaultConflictDetail {
	error?: string;
	code?: string;
	message?: string;
	conflicts?: VaultConflict[];
}

export function parseApiDetail(detail: string): unknown {
	try {
		const body = JSON.parse(detail) as { detail?: unknown };
		return body.detail ?? body;
	} catch {
		return detail;
	}
}

export function isVaultConflictDetail(detail: unknown): detail is VaultConflictDetail {
	return (
		typeof detail === "object" &&
		detail !== null &&
		((detail as { error?: unknown }).error === "vault_conflicts_blocked" ||
			(detail as { code?: unknown }).code === "vault_conflicts_blocked")
	);
}

export function formatApiError(detail: string): string {
	const parsed = parseApiDetail(detail);
	if (typeof parsed === "string") return parsed;
	if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
		const message = (parsed as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return detail;
}

export function groupVaultConflicts(conflicts: VaultConflict[]) {
	const groups = new Map<string, VaultConflict[]>();
	for (const conflict of conflicts) {
		const current = groups.get(conflict.vault_slug) ?? [];
		current.push(conflict);
		groups.set(conflict.vault_slug, current);
	}
	return Array.from(groups.entries()).map(([vaultSlug, items]) => ({ vaultSlug, items }));
}

export function VaultConflictsAlert({
	detail,
	actionLabel,
	onAction,
	actionPending,
}: {
	detail: VaultConflictDetail;
	actionLabel: string;
	onAction: () => void;
	actionPending?: boolean;
}) {
	const conflicts = detail.conflicts ?? [];
	const conflictGroups = groupVaultConflicts(conflicts);
	const vaultCount = conflictGroups.length;
	const conflictCountLabel =
		conflicts.length === 1 ? "1 key name" : `${conflicts.length} key names`;
	const conflictSourceLabel =
		vaultCount > 0 ? `${vaultCount} Vault${vaultCount === 1 ? "" : "s"}` : "another Vault";
	return (
		<Alert variant="destructive">
			<AlertTriangle />
			<AlertTitle>Vault Key Conflict</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					Key name conflict: {conflictCountLabel} already{" "}
					{conflicts.length === 1 ? "exists" : "exist"} in {conflictSourceLabel} used by this
					Project. We keep the existing keys to avoid breaking agents and skip the new keys with the
					same names. The skipped key names stay visible so you can rename or remove them later.
				</p>
				{conflictGroups.length > 0 ? (
					<ul className="max-h-40 space-y-2 overflow-auto rounded-md border bg-background/50 p-2 text-xs">
						{conflictGroups.map(({ vaultSlug, items }) => {
							return (
								<li key={vaultSlug} className="space-y-1 rounded-sm bg-background/60 px-2 py-1.5">
									<div className="flex items-center justify-between gap-2">
										<span className="min-w-0 truncate font-medium text-foreground">
											{vaultSlug} Vault
										</span>
										<Button asChild variant="ghost" size="xs">
											<Link href={`/vault?search=${encodeURIComponent(vaultSlug)}`}>
												Open Vault
											</Link>
										</Button>
									</div>
									<p className="truncate font-mono text-muted-foreground">
										{items
											.map((item) => {
												const section = item.section ? `${item.section}/` : "";
												return `${section}${item.item_name}`;
											})
											.join(", ")}
									</p>
								</li>
							);
						})}
					</ul>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onAction}
					disabled={actionPending}
				>
					{actionPending ? "Continuing…" : actionLabel}
				</Button>
			</AlertDescription>
		</Alert>
	);
}
