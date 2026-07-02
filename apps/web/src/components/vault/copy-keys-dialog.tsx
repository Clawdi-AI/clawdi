"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi } from "@/lib/api";
import type { components } from "@/lib/api-schemas";
import { identityFor } from "@/lib/identity";
import { errorMessage } from "@/lib/utils";

type VaultSummary = components["schemas"]["VaultResponse"];

/* The grab-bag escape hatch: batch-selected keys leave the default vault
 * for a named one. Values never reach the browser — `/items/copy` does the
 * decrypt/re-encrypt server-side; "move" is copy + delete-at-source. */

const NEW_VAULT = "__new__";
const CHUNK = 150; // API caps fields per request at 200

export function CopyKeysDialog({
	vault,
	keys,
	mode,
	onDone,
	children,
}: {
	vault: VaultSummary;
	keys: { section: string; name: string }[];
	mode: "copy" | "move";
	/** Called after success — the parent clears its selection. */
	onDone?: () => void;
	children: React.ReactNode;
}) {
	const api = useApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [targetChoice, setTargetChoice] = useState("");
	const [newVaultName, setNewVaultName] = useState("");

	const anyProjectId = vault.project_ids?.[0];
	const attachedCount = vault.project_ids?.length ?? 0;
	const verb = mode === "move" ? "Move" : "Copy";

	const vaultsQuery = useQuery({
		queryKey: ["vaults", "all"],
		queryFn: async () =>
			unwrap(await api.GET("/v1/vault", { params: { query: { page_size: 200 } } })),
		enabled: open,
	});
	const projectsQuery = useQuery({
		queryKey: ["projects"],
		queryFn: async () => unwrap(await api.GET("/v1/projects")),
		enabled: open,
	});
	const ownVaults = useMemo(
		() => (vaultsQuery.data?.items ?? []).filter((v) => v.is_owner !== false),
		[vaultsQuery.data],
	);
	const targetVaults = useMemo(
		() => ownVaults.filter((v) => v.slug !== vault.slug),
		[ownVaults, vault.slug],
	);
	const effectiveChoice =
		targetChoice || (targetVaults.length > 0 ? targetVaults[0].slug : NEW_VAULT);
	const creatingNewVault = effectiveChoice === NEW_VAULT;
	const newVaultSlug = useMemo(() => slugFromVaultName(newVaultName), [newVaultName]);
	const newVaultSlugTaken =
		creatingNewVault && newVaultSlug.length > 0 && ownVaults.some((v) => v.slug === newVaultSlug);
	const writableProject = useMemo(
		() =>
			(projectsQuery.data ?? []).find((p) => p.kind === "personal") ??
			(projectsQuery.data ?? []).find((p) => p.is_owner !== false),
		[projectsQuery.data],
	);
	const newVaultPending = creatingNewVault && (vaultsQuery.isLoading || projectsQuery.isLoading);
	const newVaultUnavailable =
		creatingNewVault &&
		!projectsQuery.isLoading &&
		!vaultsQuery.isLoading &&
		writableProject === undefined;
	const canRun =
		keys.length > 0 &&
		!runIsBlockedForNewVault(
			creatingNewVault,
			newVaultName,
			newVaultSlug,
			newVaultSlugTaken,
			newVaultPending,
			newVaultUnavailable,
		);

	const run = useMutation({
		mutationFn: async () => {
			let targetSlug = effectiveChoice;
			if (targetSlug === NEW_VAULT) {
				const name = newVaultName.trim();
				if (!name) throw new Error("Name the new vault first");
				targetSlug = newVaultSlug;
				if (!targetSlug) throw new Error("Use letters or numbers in the vault name");
				if (ownVaults.some((v) => v.slug === targetSlug)) {
					throw new Error("A vault with that name already exists");
				}
				if (!writableProject) throw new Error("No writable Project available yet");
				await unwrap(
					await api.POST("/v1/vault", {
						params: { query: { project_id: writableProject.id, create_only: true } },
						body: { slug: targetSlug, name },
					}),
				);
			}
			// Group by section — the copy endpoint works per section.
			const bySection = new Map<string, string[]>();
			for (const k of keys) {
				const section = k.section === "(default)" ? "" : k.section;
				const bucket = bySection.get(section);
				if (bucket) bucket.push(k.name);
				else bySection.set(section, [k.name]);
			}
			let copied = 0;
			const failed: string[] = [];
			const sourceRemoveFailed: string[] = [];
			for (const [section, names] of bySection) {
				for (let i = 0; i < names.length; i += CHUNK) {
					const fields = names.slice(i, i + CHUNK);
					let copiedInChunk = 0;
					try {
						const result = unwrap(
							await api.POST("/v1/vault/{slug}/items/copy", {
								params: {
									path: { slug: vault.slug },
									query: { project_id: anyProjectId ?? undefined },
								},
								body: { target_slug: targetSlug, section, fields },
							}),
						);
						copiedInChunk = result.copied;
						copied += result.copied;
					} catch {
						failed.push(...fields);
						continue;
					}
					if (mode === "move") {
						try {
							if (copiedInChunk > 0) {
								await unwrap(
									await api.DELETE("/v1/vault/{slug}/items", {
										params: {
											path: { slug: vault.slug },
											query: { project_id: anyProjectId ?? undefined, global_delete: true },
										},
										body: { section, fields },
									}),
								);
							}
						} catch {
							sourceRemoveFailed.push(...fields);
						}
					}
				}
			}
			if (copied === 0) {
				throw new Error(
					failed.length > 0 ? `Couldn't copy ${failed.join(", ")}` : "No keys copied",
				);
			}
			return { targetSlug, copied, failed, sourceRemoveFailed };
		},
		onSuccess: ({ targetSlug, copied, failed, sourceRemoveFailed }) => {
			qc.invalidateQueries({ queryKey: ["vaults"] });
			qc.invalidateQueries({ queryKey: ["vault-items"] });
			const sourceCleanupFailed = sourceRemoveFailed.length > 0;
			toast.success(
				`${copied} ${copied === 1 ? "key" : "keys"} ${
					mode === "move" && !sourceCleanupFailed ? "moved" : "copied"
				}`,
				{
					description:
						`Now in vault://${targetSlug}.` +
						(sourceCleanupFailed ? ` Source not removed: ${sourceRemoveFailed.join(", ")}.` : "") +
						(failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : ""),
				},
			);
			setOpen(false);
			setTargetChoice("");
			setNewVaultName("");
			onDone?.();
		},
		onError: (e) => toast.error(`Couldn't ${mode} keys`, { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setTargetChoice("");
					setNewVaultName("");
				}
			}}
		>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{verb} {keys.length} {keys.length === 1 ? "key" : "keys"} to…
					</DialogTitle>
					{/* Copy-vs-reference semantics must be explicit (Kingsley's
					    review): a copied key is an independent secret — rotating
					    one later does NOT update the other. When the user's real
					    goal is "use these keys elsewhere too", the reference move
					    (add this vault to that Project) is the right tool, so
					    offer it right here. */}
					<DialogDescription>
						{mode === "move"
							? "Values stay server-side; the originals are removed from this vault."
							: "Each key becomes an independent copy — changing a value later updates only one vault, not both."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
						<div className="space-y-1.5">
							<Label htmlFor="copy-keys-target">Destination vault</Label>
							<Select value={effectiveChoice} onValueChange={setTargetChoice}>
								<SelectTrigger id="copy-keys-target" className="w-full">
									<SelectValue placeholder="Choose a vault…" />
								</SelectTrigger>
								<SelectContent className="max-h-80">
									{targetVaults.map((v) => (
										<SelectItem key={v.slug} value={v.slug}>
											<span aria-hidden className="select-none">
												{identityFor(v.name).emoji}
											</span>
											{v.name}
										</SelectItem>
									))}
									<SelectItem value={NEW_VAULT}>
										<Plus className="size-3.5" />
										New vault…
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{effectiveChoice === NEW_VAULT ? (
							<div className="space-y-1">
								<Input
									value={newVaultName}
									onChange={(e) => setNewVaultName(e.target.value)}
									placeholder="Vault name…"
									aria-label="New vault name"
									className="sm:w-44"
								/>
								{newVaultSlugTaken ? (
									<p className="max-w-44 text-xs text-destructive">
										That vault already exists. Choose it from the list or use a different name.
									</p>
								) : null}
								{newVaultUnavailable ? (
									<p className="max-w-44 text-xs text-destructive">
										No writable Project is available yet.
									</p>
								) : null}
							</div>
						) : null}
					</div>
					{mode === "move" && attachedCount > 1 ? (
						<p className="text-xs font-medium text-warning-muted-foreground">
							{vault.name} is used by {attachedCount} Projects — moving these keys removes them from
							all of those Projects.
						</p>
					) : null}
					{mode === "copy" ? (
						<p className="text-xs text-muted-foreground">
							Just want these keys available in another Project? Use{" "}
							<span className="font-medium text-foreground">Add to Project</span> on this vault
							instead — one source of truth, changes apply everywhere.
						</p>
					) : null}
					<Button
						className="w-full"
						disabled={run.isPending || !canRun}
						onClick={() => run.mutate()}
					>
						{run.isPending ? <Spinner /> : <ArrowRight className="size-3.5" />}
						{verb} {keys.length} {keys.length === 1 ? "key" : "keys"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function runIsBlockedForNewVault(
	creatingNewVault: boolean,
	newVaultName: string,
	newVaultSlug: string,
	newVaultSlugTaken: boolean,
	newVaultPending: boolean,
	newVaultUnavailable: boolean,
): boolean {
	return (
		creatingNewVault &&
		(!newVaultName.trim() ||
			!newVaultSlug ||
			newVaultSlugTaken ||
			newVaultPending ||
			newVaultUnavailable)
	);
}
