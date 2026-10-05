import { ApiClientError, type components, createVaultSupplyClient } from "@clawdi/shared/api";
import { vaultRequestClasses } from "@clawdi/shared/ui";
import { buildVaultSupplyAgentMessage, VAULT_REQUEST_COPY } from "@clawdi/shared/view";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupTextarea,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
	MAX_ENV_IMPORT_BYTES,
	type ParsedKey,
	parseVaultRequestEnv,
	REQUEST_FIELD_NAME_RE,
} from "@/components/vault/key-import-parse";
import { env } from "@/lib/env";

type RequestContext = components["schemas"]["VaultSecretRequestStatus"];
const client = createVaultSupplyClient({
	baseUrl: env.VITE_CLAWDI_API_URL,
	fetch: (request, init) => fetch(request, init),
});
const UNAVAILABLE = VAULT_REQUEST_COPY.unavailable;

function SecretInput({
	id,
	label,
	value,
	onChange,
	disabled,
	required,
	maxLength,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	required?: boolean;
	maxLength?: number;
}) {
	const [visible, setVisible] = useState(false);
	const multiline = /[\r\n]/.test(value);
	const props = {
		id,
		"aria-label": label,
		autoComplete: "off",
		autoCapitalize: "none",
		autoCorrect: "off",
		spellCheck: false,
		"data-private": "true",
		disabled,
		maxLength,
		className: vaultRequestClasses.secretInput,
	};
	return (
		<InputGroup>
			{visible ? (
				<InputGroupTextarea
					{...props}
					wrap="soft"
					value={value}
					required={required}
					onChange={(event) => onChange(event.target.value)}
				/>
			) : (
				<InputGroupInput
					{...props}
					type="password"
					value={multiline ? "" : value}
					readOnly={multiline}
					required={required && !multiline}
					placeholder={multiline ? VAULT_REQUEST_COPY.multiline : undefined}
					onChange={(event) => onChange(event.target.value)}
					onPaste={(event) => {
						const pasted = event.clipboardData.getData("text");
						if (multiline || /[\r\n]/.test(pasted)) {
							event.preventDefault();
							const input = event.currentTarget;
							const next = multiline
								? pasted
								: value.slice(0, input.selectionStart ?? 0) +
									pasted +
									value.slice(input.selectionEnd ?? value.length);
							if (maxLength === undefined || next.length <= maxLength) onChange(next);
						}
					}}
				/>
			)}
			<InputGroupAddon align="inline-end">
				<InputGroupButton
					size="icon-xs"
					disabled={disabled}
					onClick={() => setVisible((current) => !current)}
					aria-label={`${visible ? "Hide" : "Show"} ${label}`}
					aria-pressed={visible}
					aria-controls={id}
				>
					{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}

export function VaultRequestPage() {
	const token = useRef("");
	const [context, setContext] = useState<RequestContext>();
	const [rows, setRows] = useState<
		{ id: string; name: string; value: string; required: boolean }[]
	>([]);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [preview, setPreview] = useState<{ entries: ParsedKey[]; updateFields: string[] }>();
	const [selectionError, setSelectionError] = useState("");
	const [selectionRetryable, setSelectionRetryable] = useState(false);
	const selectionGeneration = useRef(0);
	const [importBusy, setImportBusy] = useState(false);
	const [updates, setUpdates] = useState<string[]>([]);
	const [selectionAttempt, setSelectionAttempt] = useState(0);
	const [selectionReady, setSelectionReady] = useState(false);
	const names = JSON.stringify(rows.map((row) => row.name));
	const [phase, setPhase] = useState<
		"loading" | "ready" | "saving" | "done" | "unavailable" | "error"
	>("loading");
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
	const agentMessage = phase === "done" && context ? buildVaultSupplyAgentMessage(context.id) : "";

	async function copyMessage() {
		if (!agentMessage || copyState === "copying") return;
		setCopyState("copying");
		try {
			await navigator.clipboard.writeText(agentMessage);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	useEffect(() => {
		// Remove the capability from browser history before making any request.
		if (!token.current) token.current = window.location.hash.slice(1);
		window.history.replaceState(null, "", window.location.pathname);
		if (!/^v2_[A-Za-z0-9_-]{43}$/.test(token.current)) {
			setPhase("unavailable");
			return;
		}
		const controller = new AbortController();
		setPhase("loading");
		void client
			.inspect(token.current, undefined, controller.signal)
			.then((data) => {
				if (controller.signal.aborted) return;
				if (data) {
					setContext(data);
					setRows(
						data.fields.map((name) => ({
							id: crypto.randomUUID(),
							name,
							value: "",
							required: true,
						})),
					);
					setUpdates(data.update_fields);
					setPhase("ready");
				}
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					if (error instanceof ApiClientError && [410, 422].includes(error.status)) {
						setPhase("unavailable");
						return;
					}
					setError(
						error instanceof ApiClientError
							? "Could not load this request. Try again."
							: "Could not connect. Try again.",
					);
					setPhase("error");
				}
			});
		return () => controller.abort();
	}, [attempt]);

	function invalidateSelection() {
		selectionGeneration.current++;
		setSelectionReady(false);
		setUpdates([]);
		setSelectionError("");
		setSelectionRetryable(false);
	}

	useEffect(() => {
		if (phase !== "ready") return;
		const fields: string[] = JSON.parse(names);
		setSelectionReady(false);
		setUpdates([]);
		setSelectionError("");
		setSelectionRetryable(false);
		if (
			!fields.length ||
			fields.some((name) => !REQUEST_FIELD_NAME_RE.test(name)) ||
			new Set(fields).size !== fields.length
		) {
			setSelectionError(
				"Use valid, distinct field names (letters, numbers, dots, underscores, and hyphens).",
			);
			return;
		}
		const controller = new AbortController();
		const generation = selectionGeneration.current;
		const timer = window.setTimeout(() => {
			void client
				.inspect(token.current, fields, controller.signal)
				.then((data) => {
					if (controller.signal.aborted || generation !== selectionGeneration.current) return;
					setUpdates(data.update_fields);
					setSelectionReady(true);
				})
				.catch((error: unknown) => {
					if (controller.signal.aborted || generation !== selectionGeneration.current) return;
					const status = error instanceof ApiClientError ? error.status : undefined;
					if (status === 410) {
						setRows([]);
						setImportText("");
						setPreview(undefined);
						token.current = "";
						setPhase("unavailable");
					} else if (status === 409) {
						setSelectionError(
							"Selected fields changed or are reserved. Remove added fields or ask your agent for a new link.",
						);
					} else if (status === 422) {
						setSelectionError(
							"Selected field names are invalid. Use distinct names and at most 32 fields.",
						);
					} else {
						setSelectionError(
							status === undefined
								? "Could not connect to check selected fields. Try again."
								: "Could not check selected fields. The server is unavailable. Try again.",
						);
						setSelectionRetryable(true);
					}
				});
		}, 300);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [names, phase, selectionAttempt]);

	async function previewImport() {
		setError("");
		const parsed = parseVaultRequestEnv(importText);
		if (parsed.errors.length || !parsed.entries.length) {
			setError(parsed.errors[0] ?? "Enter at least one dotenv assignment.");
			return;
		}
		const fields = [
			...new Set([...rows.map((row) => row.name), ...parsed.entries.map((entry) => entry.key)]),
		];
		if (
			fields.length > 32 ||
			new Set(rows.map((row) => row.name)).size !== rows.length ||
			fields.some((name) => !REQUEST_FIELD_NAME_RE.test(name))
		) {
			setError("Use valid, distinct field names and at most 32 fields total.");
			return;
		}
		setImportBusy(true);
		try {
			const data = await client.inspect(token.current, fields);
			setPreview({ entries: parsed.entries, updateFields: data.update_fields });
		} catch (error) {
			const status = error instanceof ApiClientError ? error.status : undefined;
			if (status === 410) {
				setRows([]);
				setImportText("");
				setPreview(undefined);
				token.current = "";
				setPhase("unavailable");
			} else if (status === 409) {
				setError("Could not preview these fields. A selected field changed or is reserved.");
			} else if (status === 422) {
				setError("Selected field names are invalid. Use distinct names and at most 32 fields.");
			} else {
				setError(
					status === undefined
						? "Could not connect. Try previewing again."
						: "Could not preview these fields. The server is unavailable. Try again.",
				);
			}
		} finally {
			setImportBusy(false);
		}
	}

	function applyImport() {
		if (!preview) return;
		setRows((current) => {
			const imported = new Map(preview.entries.map((entry) => [entry.key, entry.value]));
			return [
				...current.map((row) => ({ ...row, value: imported.get(row.name) ?? row.value })),
				...preview.entries
					.filter((entry) => !current.some((row) => row.name === entry.key))
					.map((entry) => ({
						id: crypto.randomUUID(),
						name: entry.key,
						value: entry.value,
						required: false,
					})),
			];
		});
		invalidateSelection();
		setSelectionAttempt((value) => value + 1);
		setPreview(undefined);
		setImportText("");
		setImportOpen(false);
	}

	async function save() {
		if (!context || phase !== "ready" || !selectionReady || importOpen) return;
		setPhase("saving");
		setError("");
		try {
			const data = await client.supply(
				token.current,
				Object.fromEntries(rows.map((row) => [row.name, row.value])),
			);
			setContext(data);
			setRows([]);
			setImportText("");
			setPreview(undefined);
			token.current = "";
			setPhase("done");
		} catch (error) {
			const status = error instanceof ApiClientError ? error.status : undefined;
			if (status === 409) {
				setPhase("ready");
				invalidateSelection();
			} else if (status === 410) {
				setRows([]);
				setImportText("");
				setPreview(undefined);
				token.current = "";
				setPhase("unavailable");
			} else if (status !== undefined && status < 500) {
				setError("Could not save. Supply every requested field and try again.");
				setPhase("ready");
			} else {
				setError(
					"Save could not be confirmed. Ask your agent to check the request status before trying again.",
				);
				setPhase("ready");
			}
		}
	}

	if (phase === "loading") {
		return (
			<main className={vaultRequestClasses.page}>
				<p role="status" className={vaultRequestClasses.loading}>
					Loading request…
				</p>
			</main>
		);
	}

	return (
		<main className={vaultRequestClasses.page}>
			<Card className={vaultRequestClasses.card}>
				<CardHeader className={vaultRequestClasses.header}>
					<div className={vaultRequestClasses.brand}>
						<img
							src="/clawdi-logo-transparent.png"
							alt=""
							width={28}
							height={28}
							className={vaultRequestClasses.brandIcon}
						/>
						<span className={vaultRequestClasses.brandName}>Clawdi</span>
					</div>
					<CardTitle>
						<h1 className={vaultRequestClasses.title}>
							{phase === "done"
								? VAULT_REQUEST_COPY.saved
								: phase === "unavailable"
									? VAULT_REQUEST_COPY.unavailableTitle
									: VAULT_REQUEST_COPY.title}
						</h1>
					</CardTitle>
				</CardHeader>
				<CardContent>
					{phase === "unavailable" && (
						<p role="alert" className={vaultRequestClasses.muted}>
							{UNAVAILABLE}
						</p>
					)}
					{phase === "done" && agentMessage && (
						<>
							<p role="status" className={vaultRequestClasses.muted}>
								{VAULT_REQUEST_COPY.done}
							</p>
							<p className={vaultRequestClasses.receipt}>{agentMessage}</p>
							{copyState === "error" && (
								<p role="alert" className={vaultRequestClasses.error}>
									Could not copy. Select and copy the message above manually.
								</p>
							)}
							<div className={vaultRequestClasses.footer}>
								<Button onClick={copyMessage} disabled={copyState === "copying"}>
									{copyState === "copied"
										? "Copied"
										: copyState === "copying"
											? "Copying…"
											: "Copy message for agent"}
								</Button>
							</div>
						</>
					)}
					{phase === "error" && (
						<>
							<p role="alert">{error}</p>
							<div className={vaultRequestClasses.footer}>
								<Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
							</div>
						</>
					)}
					{context && (phase === "ready" || phase === "saving") && (
						<form
							className={vaultRequestClasses.form}
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<div className={vaultRequestClasses.context}>
								<p className={vaultRequestClasses.contextTitle}>
									{context.vault_name} · {context.project_name}
								</p>
								{context.section && (
									<p className={vaultRequestClasses.wrap}>Section: {context.section}</p>
								)}
								<p className={vaultRequestClasses.muted}>
									Expires {new Date(context.expires_at).toLocaleString()}
								</p>
							</div>
							<p className={vaultRequestClasses.loading}>{VAULT_REQUEST_COPY.privacy}</p>
							{!!updates.length && (
								<p className={vaultRequestClasses.loading}>
									Fields marked Update replace existing values when you save.
								</p>
							)}
							<fieldset
								disabled={phase === "saving" || importBusy || !!preview}
								className={vaultRequestClasses.fields}
							>
								{rows.map(({ id, name, value, required }) => (
									<div className={vaultRequestClasses.field} key={id}>
										<div className={vaultRequestClasses.fieldHeader}>
											{required ? (
												<Label htmlFor={`secret-${id}`}>{name}</Label>
											) : (
												<Input
													aria-label="Field name"
													value={name}
													maxLength={200}
													required
													pattern="[A-Za-z0-9_.\-]+"
													className={vaultRequestClasses.mono}
													onChange={(event) => {
														invalidateSelection();
														setRows((current) =>
															current.map((row) =>
																row.id === id ? { ...row, name: event.target.value } : row,
															),
														);
													}}
												/>
											)}
											{!required && (
												<Button
													type="button"
													variant="ghost"
													aria-label={`Remove ${name || "field"}`}
													onClick={() => {
														invalidateSelection();
														setRows((current) => current.filter((row) => row.id !== id));
													}}
												>
													Remove
												</Button>
											)}
											{updates.includes(name) && (
												<span className={vaultRequestClasses.update}>Update</span>
											)}
										</div>
										<SecretInput
											id={`secret-${id}`}
											label={required ? name : `Value for ${name || "field"}`}
											value={value}
											required
											maxLength={65536}
											disabled={phase === "saving"}
											onChange={(value) =>
												setRows((current) =>
													current.map((row) => (row.id === id ? { ...row, value } : row)),
												)
											}
										/>
									</div>
								))}

								<div className={vaultRequestClasses.actions}>
									<Button
										type="button"
										variant="outline"
										disabled={rows.length >= 32 || importOpen}
										onClick={() => {
											invalidateSelection();
											setRows((current) => [
												...current,
												{ id: crypto.randomUUID(), name: "", value: "", required: false },
											]);
										}}
									>
										Add field
									</Button>
									<Button
										type="button"
										variant="outline"
										onClick={() => {
											setImportOpen(true);
											setError("");
										}}
									>
										Import .env
									</Button>
								</div>
							</fieldset>
							{importOpen && (
								<div className={vaultRequestClasses.importPanel}>
									<p className={vaultRequestClasses.loading}>
										Paste or choose a .env file. Values stay text; variables and commands are never
										expanded.
									</p>
									{!preview && (
										<>
											<Label htmlFor="env-import">Dotenv text</Label>
											<SecretInput
												id="env-import"
												label="Dotenv text"
												value={importText}
												disabled={importBusy}
												onChange={setImportText}
											/>
											<Input
												type="file"
												aria-label="Choose .env file"
												disabled={importBusy}
												onChange={async (event) => {
													const file = event.target.files?.[0];
													event.target.value = "";
													if (!file) return;
													if (file.size > MAX_ENV_IMPORT_BYTES) {
														setError("Import must be at most 4 MiB.");
														return;
													}
													setImportBusy(true);
													try {
														setImportText(
															new TextDecoder("utf-8", { fatal: true }).decode(
																await file.arrayBuffer(),
															),
														);
													} catch {
														setError("Could not read a UTF-8 text file.");
													} finally {
														setImportBusy(false);
													}
												}}
											/>
											<Button type="button" disabled={importBusy} onClick={previewImport}>
												{importBusy ? "Checking…" : "Preview import"}
											</Button>
										</>
									)}
									{preview && (
										<>
											<p className={vaultRequestClasses.preview}>
												Apply these values to the form, then save all fields together.
											</p>
											<ul className={vaultRequestClasses.previewList}>
												{preview.entries.map((entry) => (
													<li key={entry.key} className={vaultRequestClasses.wrap}>
														<span className={vaultRequestClasses.mono}>{entry.key}</span> —{" "}
														{rows.some((row) => row.name === entry.key && row.value)
															? "Replace entered value"
															: rows.some((row) => row.name === entry.key)
																? "Fill requested field"
																: "Add field"}
														{preview.updateFields.includes(entry.key)
															? " · Update existing Vault value on save"
															: ""}
													</li>
												))}
											</ul>
											<Button type="button" onClick={applyImport}>
												Apply import
											</Button>
										</>
									)}
									<Button
										type="button"
										variant="ghost"
										disabled={importBusy}
										onClick={() => {
											setImportOpen(false);
											setImportText("");
											setPreview(undefined);
										}}
									>
										Cancel import
									</Button>
								</div>
							)}
							{(error || selectionError) && (
								<p role="alert" className={vaultRequestClasses.error}>
									{error || selectionError}
									{!error && selectionRetryable && (
										<Button
											type="button"
											variant="ghost"
											onClick={() => {
												invalidateSelection();
												setSelectionAttempt((value) => value + 1);
											}}
										>
											Retry check
										</Button>
									)}
								</p>
							)}
							<div className={vaultRequestClasses.footer}>
								<Button
									type="submit"
									disabled={phase === "saving" || !selectionReady || importOpen}
								>
									{phase === "saving" ? "Saving…" : "Save secrets"}
								</Button>
							</div>
						</form>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
