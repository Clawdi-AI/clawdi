import { readJson } from "./api-client";
import { getAuth, getConfig } from "./config";
import { resolveProjectId } from "./project-resolver";
import { getEnvIdByAgent } from "./select-adapter";

const CLAWDI_REF_RE = /clawdi:\/\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)+/g;

export interface ClawdiReference {
	raw: string;
	project?: string;
	vault: string;
	section: string;
	field: string;
	isExact: boolean;
}

export interface ClawdiReferenceUse {
	ref: ClawdiReference;
	line: number;
	column: number;
}

export interface VaultReferencePreview {
	reference: string;
	source_project_id: string;
	source_alias: string;
	source_display?: string;
	source_binding_type?: string;
	source_priority?: number;
	vault_slug?: string | null;
	section?: string;
	item_name?: string;
	precedence?: Array<{
		project_id: string;
		alias: string;
		display?: string;
		hit: boolean;
		reason: "match" | "not-found" | "skipped" | "conflict";
		binding_type?: string;
		priority?: number;
	}>;
	conflicts?: Array<{
		project_id: string;
		alias: string;
		display?: string;
		binding_type?: string;
		priority?: number;
		vault_slug?: string | null;
		section?: string;
		item_name?: string;
	}>;
}

export interface VaultReferenceHit extends VaultReferencePreview {
	value: string;
}

export interface ResolveReferenceOptions {
	project?: string;
	projectId?: string;
	agent?: string;
	allowConflicts?: boolean;
	debug?: boolean;
}

export function parseClawdiReference(input: string): ClawdiReference {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid Clawdi reference: ${input}`);
	}
	if (url.protocol !== "clawdi:") {
		throw new Error(`Expected a clawdi:// reference, got: ${input}`);
	}
	const host = decodeURIComponent(url.hostname);
	const parts = url.pathname
		.split("/")
		.filter(Boolean)
		.map((part) => decodeURIComponent(part));
	if (host === "project" && parts[1] === "vault") {
		return parseProjectReference(input, parts);
	}
	return parseRelativeReference(input, host, parts);
}

function parseRelativeReference(input: string, vault: string, parts: string[]): ClawdiReference {
	if (!vault || (parts.length !== 1 && parts.length !== 2)) {
		throw new Error(
			"Expected clawdi://<vault>/<field>, clawdi://<vault>/<section>/<field>, or clawdi://project/<project>/vault/<vault>/field/<field>.",
		);
	}
	const [sectionOrField, maybeField] = parts;
	return {
		raw: input,
		vault,
		section: maybeField === undefined ? "" : sectionOrField,
		field: maybeField ?? sectionOrField,
		isExact: false,
	};
}

function parseProjectReference(input: string, parts: string[]): ClawdiReference {
	const invalid = () =>
		new Error(
			"Expected clawdi://project/<project>/vault/<vault>/field/<field> or clawdi://project/<project>/vault/<vault>/section/<section>/field/<field>.",
		);
	if (parts.length !== 5 && parts.length !== 7) throw invalid();
	const [
		project,
		vaultKeyword,
		vault,
		maybeSectionKeyword,
		maybeSectionOrField,
		fieldKeyword,
		maybeField,
	] = parts;
	if (!project || vaultKeyword !== "vault" || !vault) throw invalid();
	if (parts.length === 5) {
		if (maybeSectionKeyword !== "field" || !maybeSectionOrField) throw invalid();
		return {
			raw: input,
			project,
			vault,
			section: "",
			field: maybeSectionOrField,
			isExact: true,
		};
	}
	if (
		maybeSectionKeyword !== "section" ||
		!maybeSectionOrField ||
		fieldKeyword !== "field" ||
		!maybeField
	) {
		throw invalid();
	}
	return {
		raw: input,
		project,
		vault,
		section: maybeSectionOrField,
		field: maybeField,
		isExact: true,
	};
}

export function scanClawdiReferences(input: string): ClawdiReference[] {
	const seen = new Set<string>();
	const refs: ClawdiReference[] = [];
	for (const match of input.matchAll(CLAWDI_REF_RE)) {
		const raw = match[0];
		if (seen.has(raw)) continue;
		seen.add(raw);
		refs.push(parseClawdiReference(raw));
	}
	return refs;
}

export function scanClawdiReferenceUses(input: string): ClawdiReferenceUse[] {
	const uses: ClawdiReferenceUse[] = [];
	for (const match of input.matchAll(CLAWDI_REF_RE)) {
		const raw = match[0];
		const index = match.index ?? 0;
		const prefix = input.slice(0, index);
		const line = prefix.split("\n").length;
		const lastNewline = prefix.lastIndexOf("\n");
		const column = index - lastNewline;
		uses.push({ ref: parseClawdiReference(raw), line, column });
	}
	return uses;
}

export async function resolveClawdiReference(
	input: string,
	opts: ResolveReferenceOptions = {},
): Promise<VaultReferenceHit> {
	const hit = await requestClawdiReference<VaultReferenceHit>(input, opts, false);
	if (typeof hit.value !== "string") {
		throw new Error("vault resolve returned no value.");
	}
	return hit;
}

export async function previewClawdiReference(
	input: string,
	opts: ResolveReferenceOptions = {},
): Promise<VaultReferencePreview> {
	return await requestClawdiReference<VaultReferencePreview>(input, opts, true);
}

async function requestClawdiReference<T extends VaultReferencePreview>(
	input: string,
	opts: ResolveReferenceOptions,
	preview: boolean,
): Promise<T> {
	if (opts.project && opts.agent) {
		throw new Error("Pass either --project or --agent, not both.");
	}
	const ref = parseClawdiReference(input);
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		throw new Error("Not logged in. Run `clawdi auth login` first.");
	}

	const params = new URLSearchParams({
		vault_slug: ref.vault,
		section: ref.section,
		field: ref.field,
	});
	if (ref.project) {
		const referenceProjectId = await resolveProjectId(apiUrl, auth.apiKey, ref.project);
		if (opts.project) {
			const explicitProjectId = await resolveProjectId(apiUrl, auth.apiKey, opts.project);
			if (explicitProjectId !== referenceProjectId) {
				throw new Error(
					`Reference points to Project ${referenceProjectId}, but --project resolved to ${explicitProjectId}. Omit --project or use a reference from that Project.`,
				);
			}
		}
		params.set("project_id", referenceProjectId);
	} else if (opts.project) {
		params.set("project_id", await resolveProjectId(apiUrl, auth.apiKey, opts.project));
	} else if (opts.projectId) {
		params.set("project_id", opts.projectId);
	}
	if (opts.agent) {
		params.set("agent_id", resolveAgentId(opts.agent));
	}
	if (opts.allowConflicts) params.set("allow_conflicts", "true");
	if (opts.debug) params.set("debug", "true");
	if (preview) params.set("preview", "true");

	const response = await fetch(`${apiUrl}/api/vault/resolve?${params.toString()}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	const body = await readJson<T | { detail?: unknown }>(response, "/api/vault/resolve");
	if (!response.ok) {
		throw new VaultReferenceResolveError(response.status, body);
	}
	return { ...(body as T), reference: input };
}

export async function resolveReferenceMap(
	refs: ClawdiReference[],
	opts: ResolveReferenceOptions = {},
): Promise<Map<string, VaultReferenceHit>> {
	const resolved = new Map<string, VaultReferenceHit>();
	for (const ref of refs) {
		if (resolved.has(ref.raw)) continue;
		resolved.set(ref.raw, await resolveClawdiReference(ref.raw, opts));
	}
	return resolved;
}

export async function previewReferenceMap(
	refs: ClawdiReference[],
	opts: ResolveReferenceOptions = {},
): Promise<Map<string, VaultReferencePreview>> {
	const resolved = new Map<string, VaultReferencePreview>();
	for (const ref of refs) {
		if (resolved.has(ref.raw)) continue;
		resolved.set(ref.raw, await previewClawdiReference(ref.raw, opts));
	}
	return resolved;
}

export function replaceResolvedReferences(
	input: string,
	resolved: Map<string, VaultReferenceHit>,
): string {
	return input.replace(CLAWDI_REF_RE, (raw) => resolved.get(raw)?.value ?? raw);
}

export function buildExactClawdiReference(
	project: string,
	vault: string,
	section: string,
	field: string,
): string {
	const parts = [
		"project",
		project,
		"vault",
		vault,
		...(section ? ["section", section] : []),
		"field",
		field,
	].map((part) => encodeURIComponent(part));
	return `clawdi://${parts.join("/")}`;
}

export function maskSecret(value: string): string {
	if (value.length <= 4) return "****";
	return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export class VaultReferenceResolveError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(resolveErrorMessage(status, body));
		this.name = "VaultReferenceResolveError";
		this.status = status;
		this.body = body;
	}
}

function resolveErrorMessage(status: number, body: unknown): string {
	const detail = extractDetail(body);
	if (status === 404) return detail.message ?? "No vault value found for reference.";
	if (status === 403) return "vault resolve requires CLI authentication.";
	if (status === 409) return detail.message ?? "Vault conflict blocked.";
	return `vault resolve failed (${status}).`;
}

function extractDetail(body: unknown): { message?: string } {
	if (body === null || typeof body !== "object" || !("detail" in body)) return {};
	const detail = (body as { detail?: unknown }).detail;
	if (detail === null || typeof detail !== "object") return {};
	const message = (detail as { message?: unknown }).message;
	return typeof message === "string" ? { message } : {};
}

function resolveAgentId(agent: string): string {
	const localEnvId = getEnvIdByAgent(agent);
	return localEnvId ?? agent;
}
