"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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

export function formatVaultConflictSummary(conflictCount: number, vaultCount: number) {
	if (conflictCount <= 0) {
		return "Key name conflict: this Project already uses keys with the same names.";
	}
	const conflictCountLabel = conflictCount === 1 ? "1 key name" : `${conflictCount} key names`;
	const verb = conflictCount === 1 ? "exists" : "exist";
	const source = vaultCount > 1 ? `across ${vaultCount} other Vaults` : "in another Vault";
	return `Key name conflict: ${conflictCountLabel} already ${verb} ${source} used by this Project.`;
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
	const [expanded, setExpanded] = useState(false);
	const visibleConflictGroups = expanded ? conflictGroups : conflictGroups.slice(0, 3);
	const visibleConflictCount = visibleConflictGroups.reduce(
		(total, group) => total + group.items.length,
		0,
	);
	const hiddenConflictCount = conflicts.length - visibleConflictCount;
	const hasHiddenConflicts = hiddenConflictCount > 0;
	return (
		<Alert variant="destructive">
			<AlertTriangle />
			<AlertTitle>Vault Key Conflict</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					{formatVaultConflictSummary(conflicts.length, conflictGroups.length)} We keep the existing
					keys to avoid breaking agents and skip the new keys with the same names. The skipped key
					names stay visible so you can rename or remove them later.
				</p>
				{visibleConflictGroups.length > 0 ? (
					<div className="space-y-2">
						<ul className="space-y-2 rounded-md border bg-background/50 p-2 text-xs">
							{visibleConflictGroups.map(({ vaultSlug, items }) => {
								return (
									<li key={vaultSlug} className="space-y-1 rounded-sm bg-background/60 px-2 py-1.5">
										<div className="flex items-center justify-between gap-2">
											<span className="min-w-0 truncate font-medium text-foreground">
												{vaultSlug} Vault
											</span>
											<Button asChild variant="ghost" size="xs">
												<Link
													href={`/vault?search=${encodeURIComponent(vaultSlug)}`}
													target="_blank"
													rel="noreferrer"
												>
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
						{hasHiddenConflicts ? (
							<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
								<span>
									Showing {visibleConflictCount} of {conflicts.length} conflicts.
								</span>
								<Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(true)}>
									Show All
								</Button>
							</div>
						) : expanded && conflicts.length > 3 ? (
							<Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(false)}>
								Show Less
							</Button>
						) : null}
					</div>
				) : null}
				<p className="text-xs">After fixing the key names, come back here to continue.</p>
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
