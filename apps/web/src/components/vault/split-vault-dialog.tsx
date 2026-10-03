"use client";

import {
	type VaultPrefixGroup as PrefixGroup,
	splitVaultKeys,
	validVaultSplit,
} from "@clawdi/shared/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Scissors } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];

export type { VaultPrefixGroup as PrefixGroup } from "@clawdi/shared/api";
export { prefixGroupsFor } from "@clawdi/shared/api";

/** Split legacy app/KEY names server-side; Shared owns grouping and transfer semantics. */

export function SplitVaultDialog({
	vault,
	groups,
	onDone,
}: {
	vault: VaultSummary;
	groups: PrefixGroup[];
	onDone?: () => void;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [excluded, setExcluded] = useState<Set<string>>(new Set());
	const [removeOriginals, setRemoveOriginals] = useState(true);
	const [slugs, setSlugs] = useState<Record<string, string>>({});

	const selected = useMemo(
		() =>
			groups
				.filter((g) => !excluded.has(g.prefix))
				.map((g) => ({ ...g, slug: slugs[g.prefix] ?? g.slug })),
		[groups, excluded, slugs],
	);
	const selectedKeyCount = selected.reduce((n, g) => n + g.keys.length, 0);
	const valid = validVaultSplit(vault, selected);

	const run = useMutation({
		mutationFn: () =>
			splitVaultKeys(vault, selected, removeOriginals, {
				create: async (body) =>
					unwrap(await api.POST("/v1/vault", { params: { query: { create_only: true } }, body })),
				copyItems: async (source, target, body) =>
					unwrap(
						await api.POST("/v1/vault/{slug}/items/copy", {
							params: {
								path: { slug: source.slug },
								query: { vault_id: source.id, target_vault_id: target.id },
							},
							body: { ...body, target_slug: target.slug },
						}),
					),
				deleteItems: async (source, body) =>
					unwrap(
						await api.DELETE("/v1/vault/{slug}/items", {
							params: {
								path: { slug: source.slug },
								query: { vault_id: source.id, global_delete: true },
							},
							body,
						}),
					),
			}),
		onSuccess: (result) => {
			if (!result.interrupted && result.groups.every((g) => g.status === "complete")) {
				toast.success(`Split into ${result.groups.length} vaults`);
				onDone?.();
			} else
				toast.warning("Split incomplete. Inspect destinations and source keys before retrying.");
		},
		onError: (e) => {
			toast.error("Couldn't split vault", { description: errorMessage(e) });
		},
		onSettled: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] }),
				qc.invalidateQueries({ queryKey: ["vault-items"] }),
			]),
	});

	if (!open && !groups.length) return null;
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (run.isPending) return;
				if (next) run.reset();
				setOpen(next);
			}}
			onOpenChangeComplete={(next) => {
				if (next) return;
				setExcluded(new Set());
				setSlugs({});
				setRemoveOriginals(true);
			}}
		>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<Scissors className="size-3.5" />
				Split into vaults…
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Split {vault.name} by app prefix</DialogTitle>
					<DialogDescription>
						Keys named <span className="font-mono">app/KEY</span> become a vault per app, renamed to
						their clean <span className="font-mono">KEY</span>. Values stay server-side. New Vaults
						are not automatically linked to Projects. Copy and deletion are non-atomic; avoid
						concurrent edits. Failed destinations may remain; inspect them before retrying.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
						{groups.map((g) => {
							const checked = !excluded.has(g.prefix);
							return (
								<div
									key={g.prefix}
									className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/50"
								>
									<Checkbox
										aria-label={`Select ${g.prefix}`}
										disabled={run.isPending || !!run.data}
										checked={checked}
										onCheckedChange={(v) => {
											setExcluded((prev) => {
												const next = new Set(prev);
												if (v === true) next.delete(g.prefix);
												else next.add(g.prefix);
												return next;
											});
										}}
									/>
									<span aria-hidden className="select-none text-sm leading-none">
										{identityFor(g.slug).emoji}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-xs">{g.prefix}</span>
									<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
										{g.keys.length} keys →
									</span>
									<Input
										aria-label={`Destination slug for ${g.prefix}`}
										value={slugs[g.prefix] ?? g.slug}
										maxLength={200}
										disabled={!checked || run.isPending || !!run.data}
										onChange={(event) => setSlugs({ ...slugs, [g.prefix]: event.target.value })}
									/>
								</div>
							);
						})}
					</div>
					<div className="flex items-center gap-2">
						<Checkbox
							id="split-remove-originals"
							checked={removeOriginals}
							disabled={run.isPending || !!run.data}
							onCheckedChange={(v) => setRemoveOriginals(v === true)}
						/>
						<Label htmlFor="split-remove-originals" className="text-sm font-normal">
							Remove the originals from {vault.name} (move)
						</Label>
					</div>
					{removeOriginals && (vault.project_ids?.length ?? 0) > 1 ? (
						<p className="text-xs font-medium text-warning-muted-foreground">
							{vault.name} is used by {vault.project_ids?.length} Projects — moved keys leave all of
							them. Link the new Vaults to those Projects afterwards.
						</p>
					) : null}
					{!valid && !run.data ? (
						<p role="alert">
							Choose distinct destination slugs using lowercase letters, numbers and hyphens,
							different from the source Vault.
						</p>
					) : null}
					{run.data ? (
						<div role="status" className="space-y-2">
							{run.data.groups.map((g) => (
								<p key={g.prefix}>
									{g.prefix} →{" "}
									{g.target ? (
										<a
											className="underline"
											href={`/vaults/${encodeURIComponent(g.target.slug)}?vault=${encodeURIComponent(g.target.id)}`}
										>
											vault://{g.slug}
										</a>
									) : (
										`vault://${g.slug}`
									)}
									: {g.status}; confirmed copies: {g.transfer?.copied ?? 0}
									{g.transfer?.sourceRemoveFailed.length
										? "; source deletion skipped or unconfirmed"
										: ""}
								</p>
							))}
							<p>
								Inspect created Vaults before starting another split. Existing Vaults are never
								reused automatically.
							</p>
							<Button onClick={() => setOpen(false)}>Close</Button>
						</div>
					) : null}
					<Button
						className="w-full"
						disabled={!valid || run.isPending || !!run.data}
						onClick={() => run.mutate()}
					>
						{run.isPending ? <Spinner /> : <Scissors className="size-3.5" />}
						{run.isPending
							? "Splitting…"
							: `Split ${selectedKeyCount} keys into ${selected.length} ${selected.length === 1 ? "vault" : "vaults"}`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
