"use client";

import { addKeysDialogClasses } from "@clawdi/shared/ui";
import { errorMessage, vaultKeyFormCopy as formCopy, identityFor } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Plus } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
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
import { Textarea } from "@/components/ui/textarea";
import { buildKeyImportPreview } from "@/components/vault/key-import-logic";
import { slugFromVaultName } from "@/components/vault/vault-slug";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { shouldBlockQueryError } from "@/lib/query-state";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

/* The #2 job of this dashboard: get keys in, fast. Paste-first composer —
 * a .env blob or a single KEY=value line, straight into any vault (with
 * inline create), from anywhere. No navigation required. */

const NEW_VAULT = "__new__";

export function AddKeysDialog({
	/** Pin the destination vault (vault detail page); omit for the picker. */
	vaultSlug,
	vaultId,
	vaultProjectId,
	children,
}: {
	vaultSlug?: string;
	vaultId?: string;
	vaultProjectId?: string;
	children?: ReactElement;
}) {
	const api = useApi();
	const $api = useOpenApi();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [vaultChoice, setVaultChoice] = useState<string>(vaultId ?? "");
	const [newVaultName, setNewVaultName] = useState("");
	const [updateExisting, setUpdateExisting] = useState(false);

	const vaultsQuery = $api.useQuery(
		"get",
		"/v1/vault",
		{
			params: { query: { page_size: 200 } },
		},
		{
			enabled: open && !vaultSlug,
		},
	);
	const ownVaults = useMemo(
		() => (vaultsQuery.data?.items ?? []).filter((v) => v.is_owner !== false),
		[vaultsQuery.data],
	);
	const vaultItems = useMemo(
		() => [
			...ownVaults.map((vault) => ({ value: vault.id, label: vault.name })),
			{ value: NEW_VAULT, label: "Create vault…" },
		],
		[ownVaults],
	);
	// Default destination: pinned slug, else the first vault, else create-new.
	const effectiveChoice = vaultChoice || (ownVaults.length > 0 ? ownVaults[0].id : NEW_VAULT);
	const selectedVault = ownVaults.find((v) => v.id === effectiveChoice);
	const effectiveSlug = selectedVault?.slug ?? (vaultSlug && vaultId ? vaultSlug : NEW_VAULT);
	const selectedVaultId = selectedVault?.id ?? vaultId;
	const selectedVaultProjectId = vaultProjectId;
	const newVaultSlug = useMemo(() => slugFromVaultName(newVaultName), [newVaultName]);
	const newVaultSlugTaken =
		effectiveChoice === NEW_VAULT &&
		newVaultSlug.length > 0 &&
		ownVaults.some((v) => v.slug === newVaultSlug);
	const newVaultPending = effectiveChoice === NEW_VAULT && !vaultSlug && vaultsQuery.isLoading;
	const blockingVaultsError = shouldBlockQueryError(vaultsQuery.error, vaultsQuery.data)
		? vaultsQuery.error
		: null;
	const existingItems = useQuery({
		queryKey: ["vault-items", selectedVaultId, effectiveSlug, selectedVaultProjectId],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/vault/{slug}/items", {
					params: {
						path: { slug: effectiveSlug },
						query: { project_id: selectedVaultProjectId, vault_id: selectedVaultId },
					},
				}),
			),
		enabled: open && effectiveChoice !== NEW_VAULT && selectedVaultId !== undefined,
	});
	const existingDefaultKeys = useMemo(
		() => new Set(existingItems.data?.["(default)"] ?? []),
		[existingItems.data],
	);
	const importPlan = useMemo(
		() => buildKeyImportPreview(text, existingDefaultKeys, updateExisting),
		[text, existingDefaultKeys, updateExisting],
	);
	const count = importPlan.parsed.entries.length;
	const importableCount = importPlan.importableRows.length;
	const destinationPending =
		open &&
		effectiveChoice !== NEW_VAULT &&
		(vaultsQuery.isLoading || selectedVaultId === undefined || existingItems.isLoading);
	const destinationLoadError = blockingVaultsError;
	const existingItemsError = shouldBlockQueryError(existingItems.error, existingItems.data)
		? existingItems.error
		: null;
	const canSave =
		importPlan.parsed.errors.length === 0 &&
		importableCount > 0 &&
		!saveDisabledForNewVault(effectiveChoice, vaultSlug, newVaultName, newVaultSlug) &&
		!newVaultSlugTaken &&
		!newVaultPending &&
		!destinationPending &&
		!destinationLoadError &&
		!existingItemsError;

	const save = useSensitiveAction(async () => {
		try {
			let slug = effectiveSlug;
			let targetVaultId = selectedVaultId;
			let projectId: string | undefined;
			if (effectiveChoice === NEW_VAULT) {
				const name = newVaultName.trim();
				if (!name) throw new Error("Name the new vault first");
				slug = newVaultSlug;
				if (!slug) throw new Error("Use letters or numbers in the vault name");
				if (ownVaults.some((v) => v.slug === slug)) {
					throw new Error("A vault with that name already exists");
				}
				projectId = vaultProjectId;
				const created = unwrap(
					await api.POST("/v1/vault", {
						params: { query: { project_id: projectId, create_only: true } },
						body: { slug, name },
					}),
				);
				targetVaultId = created.id;
			} else {
				projectId = selectedVaultProjectId;
			}
			// API caps 200 fields per write; chunk for big pastes.
			const entries = Object.entries(importPlan.fields);
			if (entries.length === 0) throw new Error("No keys to save");
			for (let i = 0; i < entries.length; i += 150) {
				await unwrap(
					await api.PUT("/v1/vault/{slug}/items", {
						params: {
							path: { slug },
							query: { project_id: projectId, vault_id: targetVaultId },
						},
						body: { section: "", fields: Object.fromEntries(entries.slice(i, i + 150)) },
					}),
				);
			}
			const summary = importPlan.summary;
			qc.invalidateQueries({ queryKey: ["get", "/v1/vault"] });
			qc.invalidateQueries({ queryKey: ["vaults", "agent-projects"] });
			qc.invalidateQueries({
				queryKey: targetVaultId ? ["vault-items", targetVaultId] : ["vault-items"],
			});
			const changed = summary.created + summary.updated;
			toast.success(`${changed} ${changed === 1 ? "key" : "keys"} saved`, {
				description:
					summary.updated > 0 || summary.skipped > 0
						? `${summary.created} new, ${summary.updated} updated, ${summary.skipped} skipped.`
						: "Key values stay protected, and linked Projects and Agents can use them.",
			});
			setOpen(false);
		} catch (error) {
			toast.error("Couldn't save keys", { description: errorMessage(error) });
			throw error;
		}
	});

	useEffect(() => {
		if (!open) return;
		setText("");
		setNewVaultName("");
		setVaultChoice(vaultId ?? "");
		setUpdateExisting(false);
	}, [open, vaultId]);

	const trigger = children ?? (
		<Button size="sm">
			<Plus className={addKeysDialogClasses.icon} />
			Add keys
		</Button>
	);

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) {
					setText("");
					setNewVaultName("");
					setVaultChoice(vaultId ?? "");
					setUpdateExisting(false);
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className={addKeysDialogClasses.dialog}>
				<DialogHeader>
					<DialogTitle>Add keys</DialogTitle>
					<DialogDescription>
						{formCopy.addDescriptionBefore}
						<span className={addKeysDialogClasses.mono}>{formCopy.format}</span>
						{formCopy.addDescriptionAfter}
					</DialogDescription>
				</DialogHeader>
				<div className={addKeysDialogClasses.body}>
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={formCopy.placeholder}
						rows={7}
						autoFocus
						spellCheck={false}
						className={addKeysDialogClasses.textarea}
					/>
					{!vaultSlug ? (
						<div className={addKeysDialogClasses.destinationRow}>
							<div className={addKeysDialogClasses.field}>
								<Label htmlFor="add-keys-vault">Into vault</Label>
								<Select
									items={vaultItems}
									value={effectiveChoice}
									onValueChange={(value) => {
										if (value !== null) setVaultChoice(value);
									}}
								>
									<SelectTrigger id="add-keys-vault" className={addKeysDialogClasses.trigger}>
										<SelectValue placeholder="Choose a vault…" />
									</SelectTrigger>
									<SelectContent>
										{ownVaults.map((v) => (
											<SelectItem key={v.id} value={v.id}>
												<span aria-hidden className={addKeysDialogClasses.emoji}>
													{identityFor(v.name).emoji}
												</span>
												{v.name}
											</SelectItem>
										))}
										<SelectItem value={NEW_VAULT}>
											<Plus className={addKeysDialogClasses.icon} />
											Create vault…
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							{effectiveChoice === NEW_VAULT ? (
								<div className={addKeysDialogClasses.newField}>
									<Input
										value={newVaultName}
										onChange={(e) => setNewVaultName(e.target.value)}
										placeholder="Vault name…"
										aria-label="Vault name"
										className={addKeysDialogClasses.newInput}
									/>
									{newVaultSlugTaken ? (
										<p className={addKeysDialogClasses.newError}>
											That vault already exists. Choose it from the list or use a different name.
										</p>
									) : null}
								</div>
							) : null}
						</div>
					) : null}
					{destinationLoadError ? (
						<ApiErrorPanel
							error={destinationLoadError}
							onRetry={() => {
								if (vaultsQuery.error) void vaultsQuery.refetch();
							}}
							title="Couldn't load destinations"
						/>
					) : null}
					{importPlan.parsed.errors.length > 0 ? (
						<Alert variant="destructive">
							<AlertCircle className={addKeysDialogClasses.alertIcon} />
							<AlertTitle>Fix import text</AlertTitle>
							<AlertDescription>
								<ul className={addKeysDialogClasses.errors}>
									{importPlan.parsed.errors.map((error, index) => (
										<li key={`${index}-${error}`}>{error}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}
					{existingItemsError ? (
						<ApiErrorPanel
							error={existingItemsError}
							onRetry={() => {
								void existingItems.refetch();
							}}
							title="Couldn't check existing keys"
						/>
					) : null}
					{importPlan.conflicts.length > 0 && importPlan.parsed.errors.length === 0 ? (
						<div className={addKeysDialogClasses.overwrite}>
							<Checkbox
								id="add-keys-update-existing"
								checked={updateExisting}
								onCheckedChange={(checked) => setUpdateExisting(checked === true)}
								className={addKeysDialogClasses.checkbox}
							/>
							<div className={addKeysDialogClasses.newField}>
								<Label
									htmlFor="add-keys-update-existing"
									className={addKeysDialogClasses.overwriteLabel}
								>
									Overwrite existing keys
								</Label>
								<p className={addKeysDialogClasses.hint}>
									{importPlan.conflicts.length} key
									{importPlan.conflicts.length === 1 ? "" : "s"} already exist. By default, they are
									skipped.
								</p>
							</div>
						</div>
					) : null}
					{importPlan.preview.length > 0 && importPlan.parsed.errors.length === 0 ? (
						<div className={addKeysDialogClasses.preview}>
							<div className={addKeysDialogClasses.previewHeader}>
								<p className={addKeysDialogClasses.previewLabel}>Preview</p>
								<div className={addKeysDialogClasses.badges}>
									<Badge variant="secondary">{importPlan.summary.created} new</Badge>
									{importPlan.conflicts.length > 0 ? (
										<Badge variant="outline">
											{updateExisting
												? `${importPlan.summary.updated} update`
												: `${importPlan.summary.skipped} skip`}
										</Badge>
									) : null}
								</div>
							</div>
							<div className={addKeysDialogClasses.previewList}>
								{importPlan.preview.slice(0, 10).map((entry) => (
									<div
										key={`${entry.line ?? "json"}-${entry.key}`}
										className={addKeysDialogClasses.previewRow}
									>
										<span className={addKeysDialogClasses.keyName} translate="no">
											{entry.key}
										</span>
										<KeyImportActionBadge action={entry.action} />
									</div>
								))}
								{importPlan.preview.length > 10 ? (
									<p className={addKeysDialogClasses.more}>
										{importPlan.preview.length - 10} more key
										{importPlan.preview.length - 10 === 1 ? "" : "s"} ready.
									</p>
								) : null}
							</div>
						</div>
					) : null}
					<div className={addKeysDialogClasses.footerRow}>
						<span className={addKeysDialogClasses.count}>
							{count} {count === 1 ? "key" : "keys"} detected
							{importPlan.summary.skipped > 0 ? ` · ${importPlan.summary.skipped} skipped` : ""}
						</span>
						<DialogFooter className={addKeysDialogClasses.footer}>
							<Button type="button" variant="ghost" onClick={() => setOpen(false)}>
								Cancel
							</Button>
							<Button
								onClick={() => void save.execute().catch(() => undefined)}
								disabled={!canSave || save.isPending}
							>
								{save.isPending ? <Spinner /> : <Check className={addKeysDialogClasses.icon} />}
								{formCopy.save} {importableCount > 0 ? importableCount : ""}
							</Button>
						</DialogFooter>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function saveDisabledForNewVault(
	effectiveChoice: string,
	vaultSlug: string | undefined,
	newVaultName: string,
	newVaultSlug: string,
): boolean {
	return effectiveChoice === NEW_VAULT && !vaultSlug && (!newVaultName.trim() || !newVaultSlug);
}

function KeyImportActionBadge({ action }: { action: "create" | "update" | "skip" }) {
	return (
		<Badge variant={action === "create" ? "secondary" : "outline"}>
			{action === "create" ? "New" : action === "update" ? "Update" : "Skip"}
		</Badge>
	);
}
