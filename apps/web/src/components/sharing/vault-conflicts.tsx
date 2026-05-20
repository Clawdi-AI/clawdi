"use client";

import { AlertTriangle } from "lucide-react";
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
	return (
		<Alert variant="destructive">
			<AlertTriangle />
			<AlertTitle>Vault Key Conflict</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					This shared Project has vault keys with the same names as keys the selected agent already
					reads earlier. Earlier Projects win; the new shared keys stay visible but are skipped when
					the agent reads secrets.
				</p>
				{conflicts.length > 0 ? (
					<ul className="max-h-28 space-y-1 overflow-auto rounded-md border bg-background/50 p-2 font-mono text-xs">
						{conflicts.map((c) => {
							const section = c.section ? `${c.section}/` : "";
							return (
								<li key={`${c.vault_slug}/${section}${c.item_name}`} className="truncate">
									{c.vault_slug}/{section}
									{c.item_name}
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
