import type { components, paths } from "@clawdi/shared/api";
import { ApiClient, unwrap } from "./api-client";
import { getClawdiAccessToken } from "./clerk-oauth";
import { getConfig } from "./config";
import { mapHttpError } from "./errors";
import { resolveProjectId } from "./project-resolver";
import { getEnvIdByAgent } from "./select-adapter";
import {
	isVaultProjectNotFoundBody,
	VAULT_PROJECT_ACCESS_ERROR,
	VAULT_PROJECT_ACCESS_HINT,
} from "./vault-errors";

const CLAWDI_REF_RE = /clawdi:\/\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)+/g;
const MAX_BULK_REFERENCES = 200;

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

// Vault resolve currently exposes an open response record in OpenAPI. Keep that
// generated contract and narrow only the value needed by local materialization.
export type VaultReferencePreview = components["schemas"]["VaultResolveResponse"] & {
	reference: string;
};
export type VaultReferenceHit = VaultReferencePreview & { value: string };

export interface ResolveReferenceOptions {
	project?: string;
	projectId?: string;
	agent?: string;
	allowConflicts?: boolean;
	debug?: boolean;
}

type VaultReferenceResolveInput = components["schemas"]["VaultReferenceResolveInput"];

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
	const hit = await requestClawdiReference(input, opts, false);
	if (typeof hit.value !== "string") {
		throw new Error("vault resolve returned no value.");
	}
	return { ...hit, value: hit.value };
}

export async function previewClawdiReference(
	input: string,
	opts: ResolveReferenceOptions = {},
): Promise<VaultReferencePreview> {
	return await requestClawdiReference(input, opts, true);
}

async function requestClawdiReference(
	input: string,
	opts: ResolveReferenceOptions,
	preview: boolean,
): Promise<VaultReferencePreview> {
	if (opts.project && opts.agent) {
		throw new Error("Pass either --project or --agent, not both.");
	}
	const ref = parseClawdiReference(input);
	const { apiUrl } = getConfig();
	const accessToken = await getClawdiAccessToken(apiUrl);

	const query: NonNullable<paths["/v1/vault/resolve"]["post"]["parameters"]["query"]> = {
		vault_slug: ref.vault,
		section: ref.section,
		field: ref.field,
	};
	if (ref.project) {
		const referenceProjectId = await resolveProjectId(apiUrl, accessToken, ref.project);
		if (opts.project) {
			const explicitProjectId = await resolveProjectId(apiUrl, accessToken, opts.project);
			if (explicitProjectId !== referenceProjectId) {
				throw new Error(
					`Reference points to project ${referenceProjectId}, but --project resolved to ${explicitProjectId}. Omit --project or use a reference from that project.`,
				);
			}
		}
		query.project_id = referenceProjectId;
	} else if (opts.project) {
		query.project_id = await resolveProjectId(apiUrl, accessToken, opts.project);
	} else if (opts.projectId) {
		query.project_id = opts.projectId;
	}
	if (opts.agent) {
		query.agent_id = resolveAgentId(opts.agent);
	}
	if (opts.allowConflicts) query.allow_conflicts = true;
	if (opts.debug) query.debug = true;
	if (preview) query.preview = true;

	const api = new ApiClient({ baseUrl: apiUrl, authToken: accessToken });
	const result = await api.POST("/v1/vault/resolve", { params: { query } });
	if (!result.response.ok) {
		if (mapHttpError({ status: result.response.status })?.exitCode === 4) unwrap(result);
		throw new VaultReferenceResolveError(result.response.status, result.error);
	}
	const body = unwrap(result);
	if (preview) {
		return stripPreviewValue(body, input);
	}
	return { ...body, reference: input };
}

export async function resolveReferenceMap(
	refs: ClawdiReference[],
	opts: ResolveReferenceOptions = {},
): Promise<Map<string, VaultReferenceHit>> {
	const hits = await requestClawdiReferenceBulk(refs, opts, false);
	return new Map(
		hits.map((hit) => {
			if (typeof hit.value !== "string")
				throw new Error(`vault resolve returned no value for ${hit.reference}.`);
			return [hit.reference, { ...hit, value: hit.value }];
		}),
	);
}

export async function previewReferenceMap(
	refs: ClawdiReference[],
	opts: ResolveReferenceOptions = {},
): Promise<Map<string, VaultReferencePreview>> {
	const hits = await requestClawdiReferenceBulk(refs, opts, true);
	return new Map(hits.map((hit) => [hit.reference, hit]));
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
	if (status === 404 && isVaultProjectNotFoundBody(body)) {
		return `${VAULT_PROJECT_ACCESS_ERROR} ${VAULT_PROJECT_ACCESS_HINT}`;
	}
	if (status === 404) return detail.message ?? "No vault value found for reference.";
	if (status === 403) return detail.message ?? "vault resolve requires CLI authentication.";
	if (status === 409) return detail.message ?? "Vault conflict blocked.";
	if (detail.message) return detail.message;
	return `vault resolve failed (${status}).`;
}

function extractDetail(body: unknown): { message?: string } {
	if (body === null || typeof body !== "object" || !("detail" in body)) return {};
	const detail = (body as { detail?: unknown }).detail;
	if (typeof detail === "string") return { message: detail };
	if (detail === null || typeof detail !== "object") return {};
	const message = (detail as { message?: unknown }).message;
	return typeof message === "string" ? { message } : {};
}

async function requestClawdiReferenceBulk(
	refs: ClawdiReference[],
	opts: ResolveReferenceOptions,
	preview: boolean,
): Promise<VaultReferencePreview[]> {
	const unique = uniqueReferences(refs);
	if (unique.length === 0) return [];
	if (opts.project && opts.agent) {
		throw new Error("Pass either --project or --agent, not both.");
	}

	const { apiUrl } = getConfig();
	const accessToken = await getClawdiAccessToken(apiUrl);

	const projectIdCache = new Map<string, string>();
	const resolveCachedProjectId = async (project: string): Promise<string> => {
		const cached = projectIdCache.get(project);
		if (cached) return cached;
		const projectId = await resolveProjectId(apiUrl, accessToken, project);
		projectIdCache.set(project, projectId);
		return projectId;
	};
	const explicitProjectId = opts.project
		? await resolveCachedProjectId(opts.project)
		: opts.projectId;
	const references: VaultReferenceResolveInput[] = [];
	for (const ref of unique) {
		let projectId: string | undefined;
		if (ref.project) {
			projectId = await resolveCachedProjectId(ref.project);
			if (opts.project && explicitProjectId !== projectId) {
				throw new Error(
					`Reference points to project ${projectId}, but --project resolved to ${explicitProjectId}. Omit --project or use a reference from that project.`,
				);
			}
		}
		references.push({
			reference: ref.raw,
			vault_slug: ref.vault,
			section: ref.section,
			field: ref.field,
			project_id: projectId,
		});
	}

	const results: components["schemas"]["VaultBulkResolveResponse"]["results"] = {};
	for (const chunk of chunkArray(references, MAX_BULK_REFERENCES)) {
		const chunkProjectId = chunk.some((ref) => !ref.project_id) ? explicitProjectId : undefined;
		const api = new ApiClient({ baseUrl: apiUrl, authToken: accessToken });
		const result = await api.POST("/v1/vault/resolve/bulk", {
			body: {
				references: chunk,
				project_id: chunkProjectId,
				agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
				allow_conflicts: Boolean(opts.allowConflicts),
				debug: Boolean(opts.debug),
				preview,
			},
		});
		const response = result.response;
		if (!response.ok) {
			if (mapHttpError({ status: response.status })?.exitCode === 4) unwrap(result);
			if (response.status === 404 && shouldFallbackToSingleResolve(result.error)) {
				return await Promise.all(
					unique.map((ref) => requestClawdiReference(ref.raw, opts, preview)),
				);
			}
			throw new VaultReferenceResolveError(response.status, result.error);
		}
		const body = unwrap(result);
		if (!isRecord(body)) {
			throw new Error("vault resolve returned an invalid bulk response.");
		}
		const resultsValue = body.results;
		if (!isRecord(resultsValue)) {
			throw new Error("vault resolve returned an invalid bulk response.");
		}
		Object.assign(results, resultsValue);
	}

	return unique.map((ref) => {
		const hit = results[ref.raw];
		if (!isRecord(hit)) {
			throw new Error(`vault resolve returned no result for ${ref.raw}.`);
		}
		if (preview) {
			return stripPreviewValue(hit, ref.raw);
		}
		return { ...hit, reference: ref.raw };
	});
}

function uniqueReferences(refs: ClawdiReference[]): ClawdiReference[] {
	const seen = new Set<string>();
	const unique: ClawdiReference[] = [];
	for (const ref of refs) {
		if (seen.has(ref.raw)) continue;
		seen.add(ref.raw);
		unique.push(ref);
	}
	return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldFallbackToSingleResolve(body: unknown): boolean {
	if (!isRecord(body)) return true;
	const detail = body.detail;
	if (!isRecord(detail)) return true;
	const code = detail.code;
	return code !== "vault_reference_not_found" && code !== "project_not_found";
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function stripPreviewValue(
	body: components["schemas"]["VaultResolveResponse"],
	reference: string,
): VaultReferencePreview {
	const { value: _value, ...preview } = body;
	return { ...preview, reference };
}

function resolveAgentId(agent: string): string {
	const localEnvId = getEnvIdByAgent(agent);
	return localEnvId ?? agent;
}
