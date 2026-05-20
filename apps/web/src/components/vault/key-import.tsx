"use client";

import { AlertCircle, Check, Upload } from "lucide-react";
import { useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type KeyImportSummary, type ParsedKey, parseVaultKeyImport } from "./key-import-parse";

interface PreviewRow extends ParsedKey {
	exists: boolean;
	action: "create" | "update" | "skip";
}

export function VaultKeyImportDialog({
	existingKeys,
	isPending,
	onImport,
}: {
	existingKeys: ReadonlySet<string>;
	isPending: boolean;
	onImport: (fields: Record<string, string>, summary: KeyImportSummary) => Promise<boolean>;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [updateExisting, setUpdateExisting] = useState(false);
	const parsed = useMemo(() => parseVaultKeyImport(text), [text]);
	const preview = useMemo<PreviewRow[]>(
		() =>
			parsed.entries.map((entry) => {
				const exists = existingKeys.has(entry.key);
				return {
					...entry,
					exists,
					action: exists ? (updateExisting ? "update" : "skip") : "create",
				};
			}),
		[existingKeys, parsed.entries, updateExisting],
	);
	const conflicts = preview.filter((entry) => entry.exists);
	const importableRows = preview.filter((entry) => entry.action !== "skip");
	const summary: KeyImportSummary = {
		created: importableRows.filter((entry) => entry.action === "create").length,
		updated: importableRows.filter((entry) => entry.action === "update").length,
		skipped: preview.filter((entry) => entry.action === "skip").length,
	};
	const canImport = parsed.errors.length === 0 && importableRows.length > 0 && !isPending;

	const reset = () => {
		setText("");
		setUpdateExisting(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (isPending && nextOpen) return;
				setOpen(nextOpen);
				if (!nextOpen) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="xs"
					className="text-muted-foreground"
					aria-label="Import keys from env or JSON"
				>
					<Upload className="size-3.5" />
					Import Keys
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[min(88vh,720px)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Import Keys</DialogTitle>
					<DialogDescription>
						Paste KEY=value lines from an env file or a flat JSON object. Review conflicts before
						anything is saved.
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-1.5">
						<Label htmlFor="vault-key-import" className="text-xs font-medium">
							Import text
						</Label>
						<Textarea
							id="vault-key-import"
							value={text}
							onChange={(event) => setText(event.target.value)}
							placeholder={"GITHUB_TOKEN=…\nSENTRY_DSN=https://…"}
							spellCheck={false}
							className="min-h-44 resize-y font-mono text-xs"
						/>
						<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
							<span>Supports one format per import:</span>
							<Badge variant="outline">env KEY=value</Badge>
							<Badge variant="outline">flat JSON</Badge>
						</div>
					</div>

					{parsed.errors.length > 0 ? (
						<Alert variant="destructive">
							<AlertCircle />
							<AlertTitle>Fix Import Text</AlertTitle>
							<AlertDescription>
								<ul className="max-h-40 list-disc space-y-1 overflow-auto pl-4">
									{parsed.errors.map((error, index) => (
										<li key={`${index}-${error}`}>{error}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					) : null}

					{conflicts.length > 0 && parsed.errors.length === 0 ? (
						<div className="flex items-start gap-3 rounded-md border bg-muted/15 p-3">
							<Checkbox
								id="vault-import-update-existing"
								checked={updateExisting}
								onCheckedChange={(checked) => setUpdateExisting(checked === true)}
								className="mt-0.5"
							/>
							<div className="space-y-1">
								<Label htmlFor="vault-import-update-existing" className="text-sm font-medium">
									Update existing keys
								</Label>
								<p className="text-xs text-muted-foreground">
									{conflicts.length} key{conflicts.length === 1 ? "" : "s"} already exist. Leave
									this off to skip them.
								</p>
							</div>
						</div>
					) : null}

					{preview.length > 0 && parsed.errors.length === 0 ? (
						<div className="rounded-md border">
							<div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
								<p className="text-xs font-medium">Preview</p>
								<div className="flex flex-wrap gap-1.5">
									<Badge variant="secondary">{summary.created} new</Badge>
									{conflicts.length > 0 ? (
										<Badge variant="outline">
											{updateExisting ? `${summary.updated} update` : `${summary.skipped} skip`}
										</Badge>
									) : null}
								</div>
							</div>
							<div className="max-h-48 divide-y overflow-auto">
								{preview.slice(0, 12).map((entry) => (
									<div
										key={`${entry.line ?? "json"}-${entry.key}`}
										className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm"
									>
										<span className="truncate font-mono text-xs" translate="no">
											{entry.key}
										</span>
										<KeyImportActionBadge action={entry.action} />
									</div>
								))}
								{preview.length > 12 ? (
									<p className="px-3 py-2 text-xs text-muted-foreground">
										{preview.length - 12} more key{preview.length - 12 === 1 ? "" : "s"} ready.
									</p>
								) : null}
							</div>
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => setOpen(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!canImport}
						onClick={async () => {
							const fields = Object.fromEntries(
								importableRows.map((entry) => [entry.key, entry.value]),
							);
							const ok = await onImport(fields, summary);
							if (ok) {
								reset();
								setOpen(false);
							}
						}}
					>
						{isPending ? <Spinner /> : <Upload className="size-3.5" />}
						{importableRows.length > 0
							? `Import ${importableRows.length} Key${importableRows.length === 1 ? "" : "s"}`
							: "Import Keys"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function KeyImportActionBadge({ action }: { action: PreviewRow["action"] }) {
	return (
		<Badge
			variant={action === "create" ? "secondary" : "outline"}
			className={cn(action === "skip" && "text-muted-foreground")}
		>
			{action === "create" ? <Check className="size-3" /> : null}
			{action === "create" ? "New" : action === "update" ? "Update" : "Skip"}
		</Badge>
	);
}
