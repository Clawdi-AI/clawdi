import type { Page, Route } from "@playwright/test";
import type { components } from "../src/lib/api-schemas";

type Project = components["schemas"]["ProjectResponse"];
type AgentProjectBinding = components["schemas"]["AgentProjectBindingResponse"];
type Skill = components["schemas"]["SkillSummaryResponse"];
type Vault = components["schemas"]["VaultResponse"];

type MutationRequest = {
	method: string;
	path: string;
	query: string;
	body: string | null;
};

export async function installProjectHubMutationHarness(
	page: Page,
	{
		agentId,
		projects: initialProjects,
		bindings: initialBindings,
		writableProjectId,
		contextBindingFailures = 0,
	}: {
		agentId: string;
		projects: readonly Project[];
		bindings: readonly AgentProjectBinding[];
		writableProjectId: string;
		contextBindingFailures?: number;
	},
) {
	const requests: MutationRequest[] = [];
	const projects = [...initialProjects];
	const bindings = [...initialBindings];
	const skillsByProject = new Map<string, Skill[]>();
	const vaults: Vault[] = [];
	const vaultItems = new Map<string, Set<string>>();
	let remainingContextBindingFailures = contextBindingFailures;

	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const mutation = method !== "GET";
		if (mutation) {
			requests.push({ method, path: url.pathname, query: url.search, body: request.postData() });
		}

		if (url.pathname === "/v1/projects" && method === "GET") {
			return fulfillJson(route, projects);
		}
		if (url.pathname === "/v1/projects" && method === "POST") {
			const body = readJsonBody(request.postData());
			const name = stringField(body, "name") || "Created Project";
			const slug = stringField(body, "slug") || "created-project";
			const project: Project = {
				id: "project-created-in-agent",
				name,
				slug,
				kind: "workspace",
				origin_environment_id: null,
				archived_at: null,
				created_at: "2026-08-04T00:00:00Z",
				is_owner: true,
				owner_display: "Test User",
				owner_handle: "test-user",
			};
			projects.push(project);
			return fulfillJson(route, project, 201);
		}

		if (url.pathname === `/v1/agents/${encodeURIComponent(agentId)}/project-bindings`) {
			return fulfillJson(route, bindings);
		}
		if (
			url.pathname === `/v1/agents/${encodeURIComponent(agentId)}/project-bindings/context` &&
			method === "POST"
		) {
			if (remainingContextBindingFailures > 0) {
				remainingContextBindingFailures -= 1;
				return fulfillJson(route, { detail: "Binding temporarily unavailable" }, 503);
			}
			const projectId = stringField(readJsonBody(request.postData()), "project_id");
			const binding: AgentProjectBinding = {
				id: `binding-${projectId}`,
				agent_id: agentId,
				project_id: projectId,
				binding_type: "context",
				priority: bindings.filter((candidate) => candidate.binding_type === "context").length + 1,
				default_write_enabled: false,
				created_at: "2026-08-04T00:00:00Z",
			};
			bindings.push(binding);
			return fulfillJson(route, binding, 201);
		}

		if (url.pathname === "/v1/skills" && method === "GET") {
			const projectId = url.searchParams.get("project_id") ?? "";
			const items = skillsByProject.get(projectId) ?? [];
			return fulfillJson(route, { items, total: items.length, page: 1, page_size: 200 });
		}

		const installMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills\/install$/);
		if (installMatch && method === "POST") {
			const projectId = decodeURIComponent(installMatch[1] ?? "");
			const skill = createSkill(projectId, "installed-skill", "Installed Skill");
			upsertSkill(skillsByProject, skill);
			return fulfillJson(route, {
				skill_key: skill.skill_key,
				name: skill.name,
				description: skill.description,
				version: skill.version,
				file_count: skill.file_count ?? 1,
				repo: "owner/repo",
			});
		}

		const uploadMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills\/upload$/);
		if (uploadMatch && method === "POST") {
			const projectId = decodeURIComponent(uploadMatch[1] ?? "");
			const skill = createSkill(projectId, "uploaded-skill", "Uploaded Skill");
			upsertSkill(skillsByProject, skill);
			return fulfillJson(route, {
				skill_key: skill.skill_key,
				name: skill.name,
				version: skill.version,
				file_count: skill.file_count ?? 1,
				content_hash: skill.content_hash,
			});
		}

		const skillMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills\/(.+)$/);
		if (skillMatch) {
			const projectId = decodeURIComponent(skillMatch[1] ?? "");
			const skillKey = decodeURIComponent(skillMatch[2] ?? "").replace(/\/content$/, "");
			const skills = skillsByProject.get(projectId) ?? [];
			const skill = skills.find((candidate) => candidate.skill_key === skillKey);
			if (method === "GET") {
				return fulfillJson(route, skill ?? { detail: "Skill not found" }, skill ? 200 : 404);
			}
			if (method === "PUT" && url.pathname.endsWith("/content") && skill) {
				const content = stringField(readJsonBody(request.postData()), "content");
				skill.content = content;
				skill.content_hash = "e".repeat(64);
				skill.version += 1;
				return fulfillJson(route, {
					skill_key: skill.skill_key,
					name: skill.name,
					version: skill.version,
					file_count: skill.file_count ?? 1,
					content_hash: skill.content_hash,
				});
			}
			if (method === "DELETE" && skill) {
				skills.splice(skills.indexOf(skill), 1);
				return fulfillJson(route, { deleted: true });
			}
		}

		if (url.pathname === "/v1/vault" && method === "GET") {
			const projectId = url.searchParams.get("project_id");
			const items = projectId
				? vaults.filter((vault) => vault.project_ids?.includes(projectId))
				: vaults;
			return fulfillJson(route, { items, total: items.length, page: 1, page_size: 200 });
		}
		if (url.pathname === "/v1/vault" && method === "POST") {
			const body = readJsonBody(request.postData());
			const slug = stringField(body, "slug");
			const name = stringField(body, "name");
			const projectId = url.searchParams.get("project_id") ?? writableProjectId;
			const vault: Vault = {
				id: "vault-created-in-agent",
				slug,
				name,
				project_ids: [projectId],
				is_owner: true,
				item_count: 0,
				created_at: "2026-08-04T00:00:00Z",
			};
			vaults.push(vault);
			vaultItems.set(vault.id, new Set());
			return fulfillJson(route, vault, 201);
		}
		if (url.pathname === "/v1/vault/detail" && method === "GET") {
			const vault = vaults.find((candidate) => candidate.id === url.searchParams.get("vault_id"));
			return fulfillJson(route, vault ?? { detail: "Vault not found" }, vault ? 200 : 404);
		}

		const vaultItemsMatch = url.pathname.match(/^\/v1\/vault\/([^/]+)\/items$/);
		if (vaultItemsMatch) {
			const vaultId = url.searchParams.get("vault_id") ?? "";
			const names = vaultItems.get(vaultId) ?? new Set<string>();
			if (method === "GET") return fulfillJson(route, { "(default)": [...names] });
			if (method === "PUT") {
				const fields = recordField(readJsonBody(request.postData()), "fields");
				for (const name of Object.keys(fields)) names.add(name);
				vaultItems.set(vaultId, names);
				const vault = vaults.find((candidate) => candidate.id === vaultId);
				if (vault) vault.item_count = names.size;
				return fulfillJson(route, { saved: Object.keys(fields).length });
			}
			if (method === "DELETE") {
				const fields = arrayField(readJsonBody(request.postData()), "fields");
				for (const name of fields) names.delete(name);
				const vault = vaults.find((candidate) => candidate.id === vaultId);
				if (vault) vault.item_count = names.size;
				return fulfillJson(route, { deleted: fields.length });
			}
		}

		const vaultMatch = url.pathname.match(/^\/v1\/vault\/([^/]+)$/);
		if (vaultMatch && method === "DELETE") {
			const vaultId = url.searchParams.get("vault_id");
			const index = vaults.findIndex((candidate) => candidate.id === vaultId);
			if (index >= 0) vaults.splice(index, 1);
			vaultItems.delete(vaultId ?? "");
			return fulfillJson(route, { deleted: true });
		}

		return route.fallback();
	});

	return { requests };
}

function createSkill(projectId: string, skillKey: string, name: string): Skill {
	return {
		id: `skill-${skillKey}`,
		skill_key: skillKey,
		name,
		description: `${name} description`,
		version: 1,
		source: "cloud",
		authority: "cloud",
		source_repo: "owner/repo",
		agent_types: ["codex", "hermes"],
		file_count: 1,
		content_hash: "d".repeat(64),
		is_active: true,
		created_at: "2026-08-04T00:00:00Z",
		updated_at: "2026-08-04T00:00:00Z",
		content: `---\nname: ${name}\ndescription: Test Skill\n---\n\nInitial instructions.\n`,
		project_id: projectId,
		project_name: "Writable Context Project",
		project_kind: "workspace",
		machine_name: null,
		environment_id: null,
	};
}

function upsertSkill(skillsByProject: Map<string, Skill[]>, skill: Skill) {
	const skills = skillsByProject.get(skill.project_id ?? "") ?? [];
	const existing = skills.findIndex((candidate) => candidate.skill_key === skill.skill_key);
	if (existing >= 0) skills.splice(existing, 1, skill);
	else skills.push(skill);
	skillsByProject.set(skill.project_id ?? "", skills);
}

function readJsonBody(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(Object.entries(parsed))
			: {};
	} catch {
		return {};
	}
}

function stringField(record: Record<string, unknown>, key: string): string {
	return typeof record[key] === "string" ? record[key] : "";
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

function arrayField(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}
