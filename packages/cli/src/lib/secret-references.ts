import { readJson } from "./api-client";
import { getAuth, getConfig } from "./config";
import { resolveProjectId } from "./project-resolver";
import { getEnvIdByAgent } from "./select-adapter";

const CLAWDI_REF_RE = /clawdi:\/\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%-]+){1,2}/g;

export interface ClawdiReference {
	raw: string;
	vault: string;
	section: string;
	field: string;
}

export interface VaultReferenceHit {
	reference: string;
	value: string;
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
	const vault = decodeURIComponent(url.hostname);
	const parts = url.pathname
		.split("/")
		.filter(Boolean)
		.map((part) => decodeURIComponent(part));
	if (!vault || (parts.length !== 1 && parts.length !== 2)) {
		throw new Error("Expected clawdi://<vault>/<field> or clawdi://<vault>/<section>/<field>.");
	}
	const [sectionOrField, maybeField] = parts;
	return {
		raw: input,
		vault,
		section: maybeField === undefined ? "" : sectionOrField,
		field: maybeField ?? sectionOrField,
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

export async function resolveClawdiReference(
	input: string,
	opts: ResolveReferenceOptions = {},
): Promise<VaultReferenceHit> {
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
	if (opts.project) {
		params.set("project_id", await resolveProjectId(apiUrl, auth.apiKey, opts.project));
	} else if (opts.projectId) {
		params.set("project_id", opts.projectId);
	}
	if (opts.agent) {
		params.set("agent_id", resolveAgentId(opts.agent));
	}
	if (opts.allowConflicts) params.set("allow_conflicts", "true");
	if (opts.debug) params.set("debug", "true");

	const response = await fetch(`${apiUrl}/api/vault/resolve?${params.toString()}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${auth.apiKey}` },
	});
	const body = await readJson<VaultReferenceHit | { detail?: unknown }>(
		response,
		"/api/vault/resolve",
	);
	if (!response.ok) {
		throw new VaultReferenceResolveError(response.status, body);
	}
	return body as VaultReferenceHit;
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

export function replaceResolvedReferences(
	input: string,
	resolved: Map<string, VaultReferenceHit>,
): string {
	return input.replace(CLAWDI_REF_RE, (raw) => resolved.get(raw)?.value ?? raw);
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
