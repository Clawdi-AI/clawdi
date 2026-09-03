import { expect, type Page, type Route, test } from "@playwright/test";

const now = new Date("2026-07-04T12:00:00.000Z");

const agents = [
	{
		id: "11111111-1111-4111-8111-111111111111",
		name: "smoke-codex",
		default_name: "Smoke Codex",
		machine_name: "smoke-machine.local",
		display_name: "Smoke Codex",
		avatar_url: null,
		sort_order: 0,
		agent_type: "codex",
		agent_version: "1.0.0",
		os: "linux",
		last_seen_at: now.toISOString(),
		last_sync_at: now.toISOString(),
		last_sync_error: null,
		last_revision_seen: 12,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: "project-smoke",
	},
	{
		id: "22222222-2222-4222-8222-222222222222",
		name: "smoke-hermes",
		default_name: "Smoke Hermes",
		machine_name: "smoke-hermes.local",
		display_name: "Smoke Hermes",
		avatar_url: null,
		sort_order: 1,
		agent_type: "hermes",
		agent_version: "1.0.0",
		os: "linux",
		last_seen_at: now.toISOString(),
		last_sync_at: now.toISOString(),
		last_sync_error: null,
		last_revision_seen: 8,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: "project-smoke",
	},
];

const projects = [
	{
		id: "project-smoke",
		name: "Smoke Project",
		slug: "smoke-project",
		kind: "environment",
		origin_environment_id: "11111111-1111-4111-8111-111111111111",
		archived_at: null,
		created_at: now.toISOString(),
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
	},
	{
		id: "project-unrelated",
		name: "Unrelated Project",
		slug: "unrelated-project",
		kind: "workspace",
		origin_environment_id: null,
		archived_at: null,
		created_at: now.toISOString(),
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
	},
];

const projectBindings = [
	{
		id: "binding-primary",
		agent_id: "11111111-1111-4111-8111-111111111111",
		project_id: "project-smoke",
		binding_type: "primary",
		priority: 0,
		default_write_enabled: true,
		created_at: now.toISOString(),
	},
];

const vaults = {
	items: [
		{
			id: "vault-scoped",
			slug: "scoped-vault",
			name: "Scoped Vault",
			project_ids: ["project-smoke"],
			is_owner: true,
			item_count: 2,
			created_at: now.toISOString(),
		},
		{
			id: "vault-unrelated",
			slug: "unrelated-vault",
			name: "Unrelated Vault",
			project_ids: ["project-unrelated"],
			is_owner: true,
			item_count: 3,
			created_at: now.toISOString(),
		},
	],
	total: 2,
	page: 1,
	page_size: 200,
};

const dashboardStats = {
	total_sessions: 1,
	total_messages: 2,
	total_tokens: 300,
	active_days: 1,
	current_streak: 1,
	longest_streak: 1,
	peak_hour: 12,
	favorite_model: "gpt-5",
	skills_count: 1,
	memories_count: 1,
	vault_count: 1,
	vault_keys_count: 1,
	connectors_count: 1,
	manual_sessions_last_7_days: 1,
	contribution: [{ date: "2026-07-04", count: 1, level: 1 }],
};

const sessions = {
	items: [
		{
			id: "session-smoke-1",
			local_session_id: "local-smoke-1",
			project_path: "/smoke",
			agent_name: "smoke-codex",
			agent_display_name: "Smoke Codex",
			agent_default_name: "Smoke Codex",
			agent_type: "codex",
			machine_name: "smoke-machine.local",
			started_at: now.toISOString(),
			ended_at: null,
			updated_at: now.toISOString(),
			last_activity_at: now.toISOString(),
			duration_seconds: 60,
			message_count: 2,
			input_tokens: 100,
			output_tokens: 200,
			cache_read_tokens: 0,
			model: "gpt-5",
			models_used: ["gpt-5"],
			summary: "Smoke session",
			tags: [],
			status: "active",
			content_hash: "smoke-hash",
		},
	],
	total: 1,
	page: 1,
	page_size: 25,
};
const _overviewSessions = {
	...sessions,
	items: Array.from({ length: 5 }, (_, index) => ({
		...sessions.items[0],
		id: `session-overview-${index + 1}`,
		local_session_id: `local-overview-${index + 1}`,
		summary: [
			"Plan release",
			"Review customer notes before the quarterly planning meeting",
			"Investigate a very long synchronization issue affecting several workspaces and prepare a clear remediation plan for the team before the next release review with every regional owner",
			"Draft update",
			"Fifth hidden session",
		][index],
		message_count: index + 2,
		input_tokens: [8, 1200, 18_500, 420, 60][index],
		output_tokens: [4, 340, 9200, 80, 20][index],
		last_activity_at: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
	})),
	total: 5,
	page_size: 3,
};

const memories = {
	items: [
		{
			id: "memory-smoke-1",
			content: "Shared account context",
			category: "context",
			tags: ["shared"],
			source: "web",
			source_session_id: null,
			source_machine_name: "smoke-machine.local",
			access_count: 1,
			created_at: now.toISOString(),
		},
	],
	total: 1,
	page: 1,
	page_size: 25,
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

type DashboardApiStubOptions = {
	accountResourceRequests?: string[];
	agentDetailRequests?: string[];
	projectResourceRequests?: string[];
	sessionsPage?: unknown;
	sessionRequests?: string[];
	connectorConnections?: readonly unknown[];
	connectorConnectionsGate?: Promise<void>;
	connectorConnectionsResponse?: { body: unknown; status: number };
	connectorCatalog?: readonly {
		name: string;
		display_name: string;
		logo: string;
		description: string;
		auth_type: string;
		connect_disabled: boolean;
		connect_disabled_reason: string | null;
	}[];
	connectorCatalogGate?: Promise<void>;
	connectorCatalogResponse?: { body: unknown; status: number };
	connectorMetadataRequests?: string[];
	connectorMetadataGate?: Promise<void>;
	connectorAuthFields?: Record<string, unknown>;
	connectorCredentialRequests?: Array<{ appName: string; body: unknown }>;
	connectorOAuthRequests?: Array<{ appName: string; body: unknown }>;
	memoryDetailGate?: Promise<void>;
	memoryDetailResponse?: { body: unknown; status: number };
	projectBindingRequests?: string[];
	projectLinkDeltaBodies?: unknown[];
	projectRequests?: string[];
	projectCreateBodies?: unknown[];
	projectBindings?: readonly unknown[];
	projectBindingsError?: { status: number; detail: string };
	projectBindingsGate?: Promise<void>;
	projects?: readonly unknown[];
	projectsGate?: Promise<void>;
	projectsResponse?: { body: unknown; status: number };
	legacySkillDetailRequests?: string[];
	skillDetailRequests?: string[];
	skillDetailResponses?: Readonly<Record<string, { body: unknown; status: number }>>;
	skillCreateRequests?: Array<{ projectId: string; body: unknown }>;
	skillRequests?: string[];
	skillsByProjectId?: Readonly<Record<string, readonly unknown[]>>;
	vaultRequests?: string[];
	vaultItemWriteRequests?: Array<{ url: string; body: unknown }>;
	vaultItems?: readonly (typeof vaults.items)[number][];
};

async function stubDashboardApi(
	page: Page,
	agentOrderRequests: string[] = [],
	options: DashboardApiStubOptions = {},
) {
	const createdProjects: unknown[] = [];
	const createdProjectBindings: unknown[] = [];
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/auth/me") {
			await fulfillJson(route, {
				id: "11111111-1111-4111-8111-111111111119",
				email: "dev@clawdi.local",
				name: "Dev User",
				auth_type: "clerk",
			});
			return;
		}
		if (
			/^\/v1\/memories\/[^/]+$/.test(url.pathname) ||
			url.pathname === "/v1/connectors" ||
			url.pathname.startsWith("/v1/connectors/")
		) {
			options.accountResourceRequests?.push(`${route.request().method()} ${url.pathname}`);
		}
		if (
			/^\/v1\/agents\/[^/]+\/project-bindings$/.test(url.pathname) ||
			url.pathname === "/v1/projects" ||
			url.pathname === "/v1/skills" ||
			url.pathname.startsWith("/v1/vault") ||
			/^\/v1\/projects\/[^/]+\/skills\//.test(url.pathname)
		) {
			options.projectResourceRequests?.push(`${route.request().method()} ${url.pathname}`);
		}
		if (url.pathname === "/v1/agents/order" && route.request().method() === "PATCH") {
			agentOrderRequests.push(route.request().postData() ?? "");
			const requested = JSON.parse(route.request().postData() ?? "{}") as {
				agent_ids?: string[];
			};
			const byId = new Map(agents.map((agent) => [agent.id, agent]));
			const ordered = (requested.agent_ids ?? [])
				.map((id) => byId.get(id))
				.filter((agent) => agent !== undefined)
				.map((agent, index) => ({ ...agent, sort_order: index }));
			await fulfillJson(route, ordered);
			return;
		}
		if (url.pathname === "/v1/agents") {
			await fulfillJson(route, agents);
			return;
		}
		const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
		if (agentMatch) {
			options.agentDetailRequests?.push(route.request().url());
			const agent = agents.find((candidate) => candidate.id === decodeURIComponent(agentMatch[1]));
			await fulfillJson(route, agent ?? { detail: "Agent not found" }, agent ? 200 : 404);
			return;
		}
		const projectBindingsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/project-bindings$/);
		if (projectBindingsMatch) {
			options.projectBindingRequests?.push(route.request().url());
			await options.projectBindingsGate;
			if (options.projectBindingsError) {
				await fulfillJson(
					route,
					{ detail: options.projectBindingsError.detail },
					options.projectBindingsError.status,
				);
				return;
			}
			const agentId = decodeURIComponent(projectBindingsMatch[1] ?? "");
			await fulfillJson(route, [
				...(options.projectBindings ??
					projectBindings.map((binding) => ({ ...binding, agent_id: agentId }))),
				...createdProjectBindings,
			]);
			return;
		}
		if (
			url.pathname === "/v1/agents/11111111-1111-4111-8111-111111111111/projects" &&
			route.request().method() === "PATCH"
		) {
			const body = route.request().postDataJSON() as {
				add_project_ids: string[];
				remove_project_ids: string[];
			};
			options.projectLinkDeltaBodies?.push(body);
			await fulfillJson(route, {
				agent_id: "11111111-1111-4111-8111-111111111111",
				added_project_ids: body.add_project_ids,
				removed_project_ids: body.remove_project_ids,
			});
			return;
		}
		if (url.pathname === "/v1/dashboard/stats") {
			await fulfillJson(route, dashboardStats);
			return;
		}
		const agentProjectCreateMatch = url.pathname.match(/^\/v1\/projects\/for-agent\/([^/]+)$/);
		if (agentProjectCreateMatch && route.request().method() === "POST") {
			const body = route.request().postDataJSON() as {
				name?: string;
				description?: string | null;
			};
			const agentId = decodeURIComponent(agentProjectCreateMatch[1] ?? "");
			const project = {
				id: "project-created",
				name: body.name ?? "Created Project",
				description: body.description ?? null,
				slug: "created-project",
				kind: "workspace",
				origin_environment_id: null,
				archived_at: null,
				created_at: now.toISOString(),
				is_owner: true,
				owner_display: "Dev User",
				owner_handle: "dev-user",
				skill_count: 0,
				vault_count: 0,
				agent_count: 1,
				member_count: 0,
			};
			options.projectCreateBodies?.push(body);
			createdProjects.push(project);
			createdProjectBindings.push({
				id: "binding-project-created",
				agent_id: agentId,
				project_id: project.id,
				binding_type: "context",
				priority: 3,
				default_write_enabled: false,
				created_at: now.toISOString(),
			});
			await fulfillJson(route, project, 201);
			return;
		}
		if (url.pathname === "/v1/projects" && route.request().method() === "POST") {
			const body = route.request().postDataJSON() as {
				name?: string;
				description?: string | null;
			};
			options.projectCreateBodies?.push(body);
			const project = {
				id: "project-created",
				name: body.name ?? "Created Project",
				description: body.description ?? null,
				slug: "created-project",
				kind: "workspace",
				origin_environment_id: null,
				archived_at: null,
				created_at: now.toISOString(),
				is_owner: true,
				owner_display: "Dev User",
				owner_handle: "dev-user",
			};
			createdProjects.push(project);
			await fulfillJson(route, project);
			return;
		}
		if (url.pathname === "/v1/projects") {
			options.projectRequests?.push(route.request().url());
			await options.projectsGate;
			if (options.projectsResponse) {
				await fulfillJson(route, options.projectsResponse.body, options.projectsResponse.status);
				return;
			}
			await fulfillJson(route, [...(options.projects ?? projects), ...createdProjects]);
			return;
		}
		const projectDetailMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
		if (projectDetailMatch && route.request().method() === "GET") {
			options.projectRequests?.push(route.request().url());
			await options.projectsGate;
			const projectId = decodeURIComponent(projectDetailMatch[1] ?? "");
			const project = [...(options.projects ?? projects), ...createdProjects].find(
				(candidate) =>
					typeof candidate === "object" &&
					candidate !== null &&
					"id" in candidate &&
					candidate.id === projectId,
			);
			await fulfillJson(route, project ?? { detail: "Project not found" }, project ? 200 : 404);
			return;
		}
		if (url.pathname === "/v1/skills") {
			options.skillRequests?.push(route.request().url());
			const projectId = url.searchParams.get("project_id") ?? "";
			const pageNumber = Number(url.searchParams.get("page") ?? "1");
			const pageSize = Number(url.searchParams.get("page_size") ?? "25");
			const projectSkills = options.skillsByProjectId?.[projectId] ?? [];
			const start = (pageNumber - 1) * pageSize;
			await fulfillJson(route, {
				items: projectSkills.slice(start, start + pageSize),
				total: projectSkills.length,
				page: pageNumber,
				page_size: pageSize,
			});
			return;
		}
		const projectSkillCreateMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills$/);
		if (projectSkillCreateMatch && route.request().method() === "POST") {
			options.skillCreateRequests?.push({
				projectId: decodeURIComponent(projectSkillCreateMatch[1] ?? ""),
				body: route.request().postDataJSON(),
			});
			await fulfillJson(route, {}, 201);
			return;
		}
		const projectSkillDetailMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/skills\/(.+)$/);
		if (projectSkillDetailMatch && route.request().method() === "GET") {
			options.skillDetailRequests?.push(route.request().url());
			const projectId = decodeURIComponent(projectSkillDetailMatch[1] ?? "");
			const skillKey = decodeURIComponent(projectSkillDetailMatch[2] ?? "");
			const response = options.skillDetailResponses?.[`${projectId}/${skillKey}`];
			await fulfillJson(
				route,
				response?.body ?? { detail: "Skill not found" },
				response?.status ?? 404,
			);
			return;
		}
		if (/^\/v1\/skills\/.+/.test(url.pathname) && route.request().method() === "GET") {
			options.legacySkillDetailRequests?.push(route.request().url());
			await fulfillJson(route, { detail: "Skill not found" }, 404);
			return;
		}
		if (url.pathname === "/v1/vault" && route.request().method() === "POST") {
			await fulfillJson(route, {});
			return;
		}
		if (url.pathname === "/v1/vault") {
			options.vaultRequests?.push(route.request().url());
			const projectId = url.searchParams.get("project_id");
			const availableVaults = options.vaultItems ?? vaults.items;
			const items = projectId
				? availableVaults.filter((vault) => vault.project_ids.includes(projectId))
				: availableVaults;
			await fulfillJson(route, {
				...vaults,
				items,
				total: items.length,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: Number(url.searchParams.get("page_size") ?? "25"),
			});
			return;
		}
		if (url.pathname === "/v1/vault/detail") {
			const vaultId = url.searchParams.get("vault_id");
			const vault = (options.vaultItems ?? vaults.items).find(
				(candidate) => candidate.id === vaultId,
			);
			await fulfillJson(route, vault ?? { detail: "Vault not found" }, vault ? 200 : 404);
			return;
		}
		if (/^\/v1\/vault\/[^/]+\/items$/.test(url.pathname)) {
			if (route.request().method() === "PUT") {
				options.vaultItemWriteRequests?.push({
					url: route.request().url(),
					body: route.request().postDataJSON(),
				});
			}
			await fulfillJson(route, { "(default)": ["API_KEY", "ACCESS_TOKEN"] });
			return;
		}
		if (url.pathname === "/v1/connectors") {
			await options.connectorConnectionsGate;
			if (options.connectorConnectionsResponse) {
				await fulfillJson(
					route,
					options.connectorConnectionsResponse.body,
					options.connectorConnectionsResponse.status,
				);
				return;
			}
			await fulfillJson(route, options.connectorConnections ?? []);
			return;
		}
		const connectorAuthFieldsMatch = url.pathname.match(/^\/v1\/connectors\/([^/]+)\/auth-fields$/);
		if (connectorAuthFieldsMatch && route.request().method() === "GET") {
			const appName = decodeURIComponent(connectorAuthFieldsMatch[1] ?? "");
			await fulfillJson(
				route,
				options.connectorAuthFields?.[appName] ?? { expected_input_fields: [] },
			);
			return;
		}
		const connectorCredentialsMatch = url.pathname.match(
			/^\/v1\/connectors\/([^/]+)\/connect-credentials$/,
		);
		if (connectorCredentialsMatch && route.request().method() === "POST") {
			options.connectorCredentialRequests?.push({
				appName: decodeURIComponent(connectorCredentialsMatch[1] ?? ""),
				body: route.request().postDataJSON(),
			});
			await fulfillJson(route, { connected: true }, 201);
			return;
		}
		const connectorOAuthMatch = url.pathname.match(/^\/v1\/connectors\/([^/]+)\/connect$/);
		if (connectorOAuthMatch && route.request().method() === "POST") {
			options.connectorOAuthRequests?.push({
				appName: decodeURIComponent(connectorOAuthMatch[1] ?? ""),
				body: route.request().postDataJSON(),
			});
			await fulfillJson(route, { connect_url: "https://accounts.example.test/oauth" });
			return;
		}
		const connectorAppMatch = url.pathname.match(/^\/v1\/connectors\/available\/([^/]+)$/);
		if (connectorAppMatch) {
			options.connectorMetadataRequests?.push(route.request().url());
			await options.connectorMetadataGate;
			const app = (
				options.connectorCatalog ?? [
					{
						name: "gmail",
						display_name: "Gmail",
						logo: "",
						description: "Email connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				]
			).find((item) => item.name === decodeURIComponent(connectorAppMatch[1]));
			await fulfillJson(route, app ?? { detail: "App not found" }, app ? 200 : 404);
			return;
		}
		if (/^\/v1\/connectors\/[^/]+\/tools$/.test(url.pathname)) {
			await fulfillJson(route, []);
			return;
		}
		if (url.pathname === "/v1/connectors/available") {
			await options.connectorCatalogGate;
			if (options.connectorCatalogResponse) {
				await fulfillJson(
					route,
					options.connectorCatalogResponse.body,
					options.connectorCatalogResponse.status,
				);
				return;
			}
			await fulfillJson(route, {
				items: options.connectorCatalog ?? [
					{
						name: "gmail",
						display_name: "Gmail",
						logo: "",
						description: "Email connector",
						auth_type: "oauth",
						connect_disabled: false,
						connect_disabled_reason: null,
					},
				],
				total: 48,
				page: Number(url.searchParams.get("page") ?? "1"),
				page_size: 24,
			});
			return;
		}
		if (url.pathname === "/v1/sessions") {
			options.sessionRequests?.push(route.request().url());
			await fulfillJson(route, options.sessionsPage ?? sessions);
			return;
		}
		const memoryDetailMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)$/);
		if (memoryDetailMatch) {
			await options.memoryDetailGate;
			if (options.memoryDetailResponse) {
				await fulfillJson(
					route,
					options.memoryDetailResponse.body,
					options.memoryDetailResponse.status,
				);
				return;
			}
			const memory = memories.items.find(
				(item) => item.id === decodeURIComponent(memoryDetailMatch[1]),
			);
			await fulfillJson(route, memory ?? { detail: "Memory not found" }, memory ? 200 : 404);
			return;
		}
		if (url.pathname === "/v1/memories") {
			await fulfillJson(route, memories);
			return;
		}
		if (url.pathname === "/v1/settings") {
			await fulfillJson(route, { memory_provider: "builtin", mem0_api_key: null });
			return;
		}
		if (url.pathname === "/v1/auth/keys") {
			await fulfillJson(route, []);
			return;
		}
		await fulfillJson(route, {});
	});
}

async function expectSidebarNavigationGroups(
	page: Page,
	expected: Array<{ label: string | null; items: string[] }>,
) {
	const groups = page
		.getByTestId("app-sidebar")
		.locator('[data-slot="sidebar-content"] > [data-slot="sidebar-group"]');
	await expect(groups).toHaveCount(expected.length);
	for (const [index, group] of expected.entries()) {
		const heading = groups.nth(index).locator('[data-slot="sidebar-group-label"]');
		if (group.label) await expect(heading).toHaveText(group.label);
		else await expect(heading).toHaveCount(0);
		await expect(groups.nth(index).getByRole("link")).toHaveText(group.items);
	}
	await expect(groups.locator('[data-slot="sidebar-group-label"]:empty')).toHaveCount(0);
}

test("sidebar shortcut preserves the desktop focus rail and Escape closes the mobile drawer", async ({
	page,
}) => {
	await stubDashboardApi(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");

	const trigger = page.getByRole("button", { name: "Toggle Sidebar" });
	const separator = page.locator('header [data-slot="separator"]');
	const focusRail = page.getByTestId("app-sidebar-agent-rail");
	const navigationPane = page.getByTestId("app-sidebar");
	const desktopSidebar = page.locator('[data-slot="sidebar"][data-state]');
	await expect(trigger).toBeHidden();
	await expect(separator).toBeHidden();
	await expect(focusRail).toBeVisible();
	await expect(desktopSidebar).toHaveAttribute("data-state", "expanded");
	await expect(page.getByTestId("app-sidebar-agent-tile")).toHaveCount(2);
	await page.keyboard.press("ControlOrMeta+b");
	await expect(desktopSidebar).toHaveAttribute("data-state", "collapsed");
	await expect
		.poll(async () => {
			const [railBox, paneBox] = await Promise.all([
				focusRail.boundingBox(),
				navigationPane.boundingBox(),
			]);
			if (!railBox || !paneBox) return false;
			return paneBox.x + paneBox.width <= railBox.x + 1;
		})
		.toBe(true);
	await expect(focusRail).toBeVisible();

	await page.setViewportSize({ width: 320, height: 568 });
	await expect(trigger).toBeVisible();
	await expect(separator).toBeVisible();
	await expect(separator).toHaveCSS("width", "1px");
	await expect(separator).toHaveCSS("height", "16px");
	await trigger.click();
	const drawer = page.getByRole("dialog", { name: "Sidebar" });
	await expect(drawer).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
});

test("Console and connected agents use the scoped navigation grammar", async ({ page }) => {
	await stubDashboardApi(page);
	await page.goto("/");
	await expectSidebarNavigationGroups(page, [
		{ label: null, items: ["Overview", "Agents", "Sessions", "Memories"] },
		{ label: "Library", items: ["Projects", "Skills", "Vaults", "Connectors"] },
	]);

	await page.goto("/agents/11111111-1111-4111-8111-111111111111");
	await expectSidebarNavigationGroups(page, [
		{ label: null, items: ["Overview", "Sessions"] },
		{ label: "Workspace", items: ["Projects", "Skills", "Vaults"] },
		{ label: "Shared", items: ["Memories", "Connectors"] },
		{ label: null, items: ["Settings"] },
	]);
});

test("connected primary Project navigation stays hidden until scope resolves", async ({ page }) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	await stubDashboardApi(page, [], { projectBindingsGate });

	await page.goto("/agents/11111111-1111-4111-8111-111111111111");
	const sidebar = page.getByTestId("app-sidebar");
	const workspaceGroup = sidebar.getByRole("group", { name: "Workspace", exact: true });
	await expect(workspaceGroup).toBeVisible();
	await expect(workspaceGroup.getByRole("link")).toHaveText(["Projects"]);
	await expect(sidebar.getByRole("group", { name: "Shared", exact: true })).toBeVisible();

	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect(workspaceGroup.getByRole("link")).toHaveText(["Projects", "Skills", "Vaults"]);
	expect(
		await sidebar.locator('[data-slot="sidebar-group-label"]').allTextContents(),
	).not.toContain("Smoke Project");
});

test("connected agent settings protects an unsaved display name", async ({ page }) => {
	await stubDashboardApi(page);
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/settings");
	const displayName = page.getByRole("textbox", { name: "Agent name" });
	await displayName.fill("Unsaved agent name");

	const sessionsLink = page
		.locator('a[href="/agents/11111111-1111-4111-8111-111111111111/sessions"]')
		.first();
	await sessionsLink.click();
	const warning = page.getByRole("alertdialog", { name: "Discard unsaved changes?" });
	await expect(warning).toBeVisible();
	await expect(page).toHaveURL(/\/agents\/11111111-1111-4111-8111-111111111111\/settings$/);

	await warning.getByRole("button", { name: "Keep editing" }).click();
	await expect(displayName).toHaveValue("Unsaved agent name");
	await sessionsLink.click();
	await warning.getByRole("button", { name: "Discard changes" }).click();
	await expect(page).toHaveURL(/\/agents\/11111111-1111-4111-8111-111111111111\/sessions$/);
});

test("connected Agent Memories keeps established UI through nested list and detail navigation", async ({
	page,
}, testInfo) => {
	await stubDashboardApi(page);
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/memories");

	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page).toHaveTitle("Memories · Clawdi");
	await expect(page.locator('[data-slot="breadcrumb-page"]')).toHaveText("Memories");
	await expect(
		main.getByText("Memories are shared across all agents.", {
			exact: true,
		}),
	).toHaveCount(1);
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	await expect(main.getByTestId("memories-surface")).toBeVisible();
	const memoryCard = main.locator("article").filter({ hasText: "Shared account context" });
	await expect(memoryCard).toBeVisible();
	await expect(memoryCard.getByRole("link")).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/memories/memory-smoke-1",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	const deleteMemoryButton = memoryCard.getByRole("button", { name: /Delete memory:/ });
	const deleteMemoryBox = await deleteMemoryButton.boundingBox();
	expect(deleteMemoryBox?.width ?? 0).toBeGreaterThanOrEqual(44);
	expect(deleteMemoryBox?.height ?? 0).toBeGreaterThanOrEqual(44);
	expect(
		await page
			.locator("html")
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	await main.screenshot({ path: testInfo.outputPath("connected-memories-mobile.png") });
	await page.setViewportSize({ width: 1280, height: 900 });
	await memoryCard.getByRole("link").click();
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/memories/memory-smoke-1",
	);
	await expect(
		main.getByRole("heading", { name: "Shared account context", level: 1 }),
	).toBeVisible();
	await expect(main.getByText("All agents", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Open in resource library" })).toHaveCount(0);

	const sidebar = page.getByTestId("app-sidebar");
	const sessionsLink = sidebar.getByRole("link", { name: "Sessions", exact: true });
	const memoriesLink = sidebar.getByRole("link", { name: "Memories", exact: true });
	await expect(memoriesLink).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/memories",
	);
	await expect(sidebar.getByRole("link", { name: "Connectors", exact: true })).toBeVisible();
	expect(await sessionsLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(false);
	expect(await memoriesLink.evaluate((element) => element.hasAttribute("data-active"))).toBe(true);
	await memoriesLink.click();
	await expect(page).toHaveURL("/agents/11111111-1111-4111-8111-111111111111/memories");
});

test("nested account resources fail closed when the Agent does not exist", async ({ page }) => {
	const accountResourceRequests: string[] = [];
	const projectResourceRequests: string[] = [];
	await stubDashboardApi(page, [], { accountResourceRequests, projectResourceRequests });
	const main = page.locator("main");

	for (const path of [
		"/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/memories/memory-smoke-1",
		"/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/connectors/gmail",
		"/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/project-access/project-smoke",
		"/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/skills/scoped-skill?project=project-smoke",
		"/agents/ffffffff-ffff-4fff-8fff-ffffffffffff/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	]) {
		await page.goto(path);
		await expect(main.getByText("Agent not found", { exact: true })).toBeVisible();
		await expect(
			main.getByText("This Agent does not exist or is no longer available."),
		).toBeVisible();
		await expect(page).toHaveURL(path);
		await main.getByRole("button", { name: "Back to Agents" }).click();
		await expect(page).toHaveURL("/agents");
	}

	expect(accountResourceRequests).toEqual([]);
	expect(projectResourceRequests).toEqual([]);
});

test("connected all-agent detail loading, not-found, and error states keep Agent scope", async ({
	page,
}) => {
	let releaseMemory: (() => void) | undefined;
	let releaseConnector: (() => void) | undefined;
	const memoryDetailGate = new Promise<void>((resolve) => {
		releaseMemory = resolve;
	});
	const connectorMetadataGate = new Promise<void>((resolve) => {
		releaseConnector = resolve;
	});
	await stubDashboardApi(page, [], {
		memoryDetailGate,
		connectorMetadataGate,
		connectorConnectionsResponse: { body: { detail: "Connections unavailable" }, status: 503 },
	});
	const main = page.locator("main");

	await page.goto("/agents/11111111-1111-4111-8111-111111111111/memories/memory-smoke-1");
	await expect(main.locator('[data-slot="skeleton"]').first()).toBeVisible();
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/memories/memory-smoke-1",
	);
	releaseMemory?.();
	await expect(
		main.getByRole("heading", { name: "Shared account context", level: 1 }),
	).toBeVisible();

	await page.goto("/agents/11111111-1111-4111-8111-111111111111/memories/missing-memory");
	await expect(main.getByText("Memory not found", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/memories/missing-memory",
	);
	await page.route("**/v1/memories/error-memory", async (route) => {
		await fulfillJson(route, { detail: "Memory service unavailable" }, 503);
	});
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/memories/error-memory");
	await expect(main.getByText("Couldn't load memory", { exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/memories/error-memory",
	);

	await page.goto("/agents/11111111-1111-4111-8111-111111111111/connectors/gmail");
	await expect(main.locator('[data-slot="skeleton"]').first()).toBeVisible();
	await expect(page).toHaveURL("/agents/11111111-1111-4111-8111-111111111111/connectors/gmail");
	releaseConnector?.();
	await expect(main.getByRole("heading", { name: "Gmail", level: 1 })).toBeVisible();
	await expect(main.getByText("Couldn't load connections", { exact: true })).toBeVisible({
		timeout: 12_000,
	});

	await page.goto("/agents/11111111-1111-4111-8111-111111111111/connectors/missing-connector");
	await expect(main.getByText("Connector unavailable", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/connectors/missing-connector",
	);
	await page.route("**/v1/connectors/available/error-connector", async (route) => {
		await fulfillJson(route, { detail: "Connector service unavailable" }, 503);
	});
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/connectors/error-connector");
	await expect(main.getByText("Couldn't load connector", { exact: true })).toBeVisible({
		timeout: 12_000,
	});
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/connectors/error-connector",
	);
});

test("connector cards complete each authentication flow in Agent scope", async ({ page }) => {
	const credentialRequests: Array<{ appName: string; body: unknown }> = [];
	const oauthRequests: Array<{ appName: string; body: unknown }> = [];
	await stubDashboardApi(page, [], {
		connectorCatalog: [
			{
				name: "gmail",
				display_name: "Gmail",
				logo: "",
				description: "Email connector",
				auth_type: "oauth",
				connect_disabled: false,
				connect_disabled_reason: null,
			},
			{
				name: "api-tool",
				display_name: "API Tool",
				logo: "",
				description: "Credential connector",
				auth_type: "api_key",
				connect_disabled: false,
				connect_disabled_reason: null,
			},
			{
				name: "public-data",
				display_name: "Public Data",
				logo: "",
				description: "No account required",
				auth_type: "no_auth",
				connect_disabled: false,
				connect_disabled_reason: null,
			},
			{
				name: "admin-oauth",
				display_name: "Admin OAuth",
				logo: "",
				description: "Workspace-managed connector",
				auth_type: "oauth",
				connect_disabled: true,
				connect_disabled_reason:
					"This Connector needs additional OAuth configuration before it can be connected. Contact support to continue.",
			},
		],
		connectorAuthFields: {
			"api-tool": {
				expected_input_fields: [
					{
						name: "api_key",
						display_name: "API key",
						description: "Key used by API Tool",
						required: true,
						is_secret: true,
					},
				],
			},
		},
		connectorCredentialRequests: credentialRequests,
		connectorOAuthRequests: oauthRequests,
	});

	const agentConnectors = "/agents/11111111-1111-4111-8111-111111111111/connectors";
	await page.goto(agentConnectors);
	const main = page.locator("main");
	await expect(main.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();

	const gmailCard = main.getByRole("link", { name: "Gmail" }).locator("..");
	const popupPromise = page.waitForEvent("popup");
	await gmailCard.getByRole("button", { name: "Connect", exact: true }).click();
	const popup = await popupPromise;
	await expect.poll(() => oauthRequests).toHaveLength(1);
	const oauthRequest = oauthRequests[0];
	expect(oauthRequest?.appName).toBe("gmail");
	if (
		typeof oauthRequest?.body !== "object" ||
		oauthRequest.body === null ||
		!("redirect_url" in oauthRequest.body) ||
		typeof oauthRequest.body.redirect_url !== "string"
	) {
		throw new Error("Expected the OAuth request to include a redirect_url");
	}
	expect(new URL(oauthRequest.body.redirect_url).pathname).toBe(`${agentConnectors}/gmail`);
	await popup.close();

	const publicDataCard = main.getByRole("link", { name: "Public Data" }).locator("..");
	await expect(publicDataCard.getByText("Ready", { exact: true })).toBeVisible();

	const unavailable = main.getByLabel(/Unavailable: This Connector needs additional OAuth/);
	await expect(unavailable).toBeVisible();

	const apiToolCard = main.getByRole("link", { name: "API Tool" }).locator("..");
	await apiToolCard.getByRole("button", { name: "Connect", exact: true }).click();
	const credentialDialog = page.getByRole("dialog", { name: "Connect API Tool" });
	await credentialDialog.getByLabel("API key").fill("browser-secret-key");
	await credentialDialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(credentialDialog).toHaveCount(0);
	await expect
		.poll(() => credentialRequests)
		.toEqual([
			{
				appName: "api-tool",
				body: { credentials: { api_key: "browser-secret-key" } },
			},
		]);
	await expect(page).toHaveURL(agentConnectors);
});

async function stubConnectedAgentResources(page: Page) {
	const skillRequests: string[] = [];
	const skillCreateRequests: Array<{ projectId: string; body: unknown }> = [];
	const vaultRequests: string[] = [];
	const vaultItemWriteRequests: Array<{ url: string; body: unknown }> = [];
	const projectCreateBodies: unknown[] = [];
	const projectLinkDeltaBodies: unknown[] = [];
	const projectBindingRequests: string[] = [];
	const projectRequests: string[] = [];
	const longContextProjectName =
		"Automation Library for exceptionally long production workflow names across several teams";
	const longContextProjectSlug =
		"automation-library-for-exceptionally-long-production-workflow-names-across-several-teams";
	const longContextProjectDescription =
		"Reusable instructions and protected Vault access for exceptionally long production workflows across several teams";
	const projectAccessBindings = [
		{
			...projectBindings[0],
		},
		{
			id: "binding-context-later",
			agent_id: "11111111-1111-4111-8111-111111111111",
			project_id: "project-context-later",
			binding_type: "context",
			priority: 2,
			default_write_enabled: false,
			created_at: "2026-07-04T12:02:00.000Z",
		},
		{
			id: "binding-context-first",
			agent_id: "11111111-1111-4111-8111-111111111111",
			project_id: "project-context-first",
			binding_type: "context",
			priority: 1,
			default_write_enabled: false,
			created_at: "2026-07-04T12:01:00.000Z",
		},
	];
	const projectAccessProjects = [
		...projects,
		{
			id: "project-context-first",
			name: "Team Knowledge",
			slug: "team-knowledge",
			description: "Shared review instructions and protected Vault access",
			kind: "workspace",
			origin_environment_id: null,
			archived_at: null,
			created_at: now.toISOString(),
			is_owner: false,
			owner_display: "Teammate",
			owner_handle: "teammate",
		},
		{
			id: "project-context-later",
			name: longContextProjectName,
			slug: longContextProjectSlug,
			description: longContextProjectDescription,
			kind: "workspace",
			origin_environment_id: null,
			archived_at: null,
			created_at: now.toISOString(),
			is_owner: true,
			owner_display: "Dev User",
			owner_handle: "dev-user",
		},
		{
			id: "project-batch-second",
			name: "Release Project",
			slug: "release-project",
			description: "Release checklists and protected Vault access",
			kind: "workspace",
			origin_environment_id: null,
			archived_at: null,
			created_at: now.toISOString(),
			is_owner: true,
			owner_display: "Dev User",
			owner_handle: "dev-user",
		},
	];
	const projectSkill = (projectId: string, skillKey: string, name: string) => ({
		id: `${projectId}-${skillKey}`,
		skill_key: skillKey,
		name,
		description: `${name} instructions`,
		version: 1,
		source: projectId === "project-smoke" ? "agent_sync" : "cloud",
		authority: projectId === "project-smoke" ? "agent_sync" : "cloud",
		source_repo: null,
		agent_types: ["codex"],
		file_count: 1,
		content_hash: "a".repeat(64),
		is_active: true,
		created_at: now.toISOString(),
		updated_at: now.toISOString(),
		project_id: projectId,
		project_name: projectId === "project-smoke" ? "Smoke Project" : "Team Knowledge",
		project_kind: projectId === "project-smoke" ? "environment" : "workspace",
	});
	const projectAccessVaults = [
		vaults.items[0],
		{
			...vaults.items[0],
			id: "vault-team",
			slug: "team-vault",
			name: "Team Vault",
			project_ids: ["project-context-first"],
		},
		{
			...vaults.items[0],
			id: "vault-shared",
			slug: "shared-vault",
			name: "Shared Vault",
			project_ids: ["project-smoke", "project-context-first"],
		},
		vaults.items[1],
	];

	await stubDashboardApi(page, [], {
		projectBindings: projectAccessBindings,
		projects: projectAccessProjects,
		skillsByProjectId: {
			"project-smoke": [
				projectSkill("project-smoke", "primary-only", "Primary-only Skill"),
				projectSkill("project-smoke", "shared-workflow", "Shared Workflow"),
			],
			"project-context-first": [
				projectSkill("project-context-first", "team-only", "Team-only Skill"),
				projectSkill("project-context-first", "shared-workflow", "Shared Workflow"),
			],
		},
		skillRequests,
		skillCreateRequests,
		vaultRequests,
		vaultItemWriteRequests,
		vaultItems: projectAccessVaults,
		projectCreateBodies,
		projectLinkDeltaBodies,
		projectBindingRequests,
		projectRequests,
	});

	return {
		skillRequests,
		skillCreateRequests,
		vaultRequests,
		vaultItemWriteRequests,
		projectCreateBodies,
		projectLinkDeltaBodies,
		projectBindingRequests,
		projectRequests,
		longContextProjectName,
		longContextProjectSlug,
		longContextProjectDescription,
	};
}

test("connected agent resources select Projects before scoped Skills and Vaults", async ({
	page,
}, testInfo) => {
	const {
		skillRequests,
		projectCreateBodies,
		projectLinkDeltaBodies,
		projectBindingRequests,
		projectRequests,
		longContextProjectName,
		longContextProjectSlug,
		longContextProjectDescription,
	} = await stubConnectedAgentResources(page);

	await page.setViewportSize({ width: 1280, height: 900 });
	const main = page.locator("main");
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/project-access");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	const projectStack = main.getByTestId("agent-project-stack");
	const projectGrid = projectStack.getByTestId("agent-project-grid");
	const projectCards = projectGrid.getByTestId("agent-project-card");
	await expect(projectCards).toHaveCount(2);
	expect(
		await projectGrid.evaluate(
			(element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
		),
	).toBe(3);
	for (const card of await projectCards.all()) {
		await expect(card.locator(":scope > div")).toHaveCSS("border-top-width", "1px");
	}
	await expect(projectCards.nth(0)).toContainText("Team Knowledge");
	await expect(projectCards.nth(0)).toContainText("Viewer");
	await expect(projectCards.nth(1)).toContainText(longContextProjectName);
	await projectCards.nth(0).hover();
	await expect(projectStack.getByText(/Project order/)).toHaveCount(0);
	await expect(projectStack.getByRole("button", { name: /Move .* (up|down)/ })).toHaveCount(0);
	await expect(projectCards.nth(0).getByRole("button", { name: /Unlink/ })).toHaveCount(0);
	await expect(projectStack.getByLabel("Project to link")).toHaveCount(0);
	await expect(
		projectStack.getByRole("button", { name: "Create project", exact: true }),
	).toBeVisible();
	await projectStack.getByRole("button", { name: "Create project", exact: true }).click();
	const createProjectDialog = page.getByRole("dialog", { name: "Create project" });
	await createProjectDialog.getByLabel("Name").fill("Release Review");
	await createProjectDialog
		.getByLabel("Description")
		.fill("Review instructions and protected Vault access");
	await createProjectDialog.getByRole("button", { name: "Create project" }).click();
	await expect(createProjectDialog).toHaveCount(0);
	await expect
		.poll(() => projectCreateBodies)
		.toEqual([
			{
				name: "Release Review",
				description: "Review instructions and protected Vault access",
			},
		]);
	expect(projectLinkDeltaBodies).toEqual([]);
	await expect(projectGrid.getByTestId("agent-project-card")).toHaveCount(3);
	await expect(projectGrid.getByText("Release Review", { exact: true })).toBeVisible();
	const createdToast = page
		.locator("[data-sonner-toast]")
		.filter({ hasText: "Project created and linked" });
	await createdToast.getByRole("button", { name: "Open project" }).click();
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === "/projects/project-created" &&
			url.searchParams.get("from") === "/agents/11111111-1111-4111-8111-111111111111/project-access"
		);
	});
	await page.goBack();
	await expect(page).toHaveURL(/\/agents\/11111111-1111-4111-8111-111111111111\/project-access$/);
	const bindingReadsBeforeLink = projectBindingRequests.length;
	const projectReadsBeforeLink = projectRequests.length;
	const addProjectTrigger = projectStack.getByRole("button", {
		name: "Manage projects",
		exact: true,
	});
	await expect(addProjectTrigger).toBeVisible();
	await addProjectTrigger.click();
	const addProjectDialog = page.getByTestId("agent-project-add-dialog");
	await expect(addProjectDialog).toBeVisible();
	await expect(addProjectDialog.getByRole("heading", { name: "Manage projects" })).toBeVisible();
	const linkedProject = addProjectDialog.getByRole("checkbox", {
		name: "Team Knowledge access",
	});
	await expect(linkedProject).toBeChecked();
	await expect(linkedProject).toBeEnabled();
	await expect(addProjectDialog.getByText("Linked", { exact: true })).toHaveCount(0);
	await expect(addProjectDialog.getByText("Available", { exact: true })).toHaveCount(0);
	await linkedProject.click();
	await expect(linkedProject).not.toBeChecked();
	const releaseProject = addProjectDialog.getByRole("checkbox", { name: "Release Project access" });
	await expect(releaseProject).not.toBeChecked();
	await releaseProject.click();
	await expect(addProjectDialog.getByRole("button", { name: "Save changes" })).toBeEnabled();
	await addProjectDialog.getByRole("button", { name: "Save changes" }).click();
	await expect(addProjectDialog).toHaveCount(0);
	await expect
		.poll(() => projectLinkDeltaBodies)
		.toEqual([
			{
				add_project_ids: ["project-batch-second"],
				remove_project_ids: ["project-context-first"],
			},
		]);
	await expect.poll(() => projectBindingRequests.length).toBeGreaterThan(bindingReadsBeforeLink);
	await expect.poll(() => projectRequests.length).toBeGreaterThan(projectReadsBeforeLink);

	await projectStack.screenshot({
		path: testInfo.outputPath("connected-agent-projects-desktop.png"),
	});
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await projectStack.screenshot({ path: testInfo.outputPath("connected-agent-projects-dark.png") });
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));

	await page.setViewportSize({ width: 2000, height: 1000 });
	const centeredAgentSurface = projectStack.locator(
		"xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' max-w-7xl ')][1]",
	);
	expect(
		await centeredAgentSurface.evaluate((element) => element.getBoundingClientRect().width),
	).toBeLessThanOrEqual(1280);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(projectCards.nth(1)).toBeVisible();
	expect(
		await projectGrid.evaluate(
			(element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
		),
	).toBe(1);
	const longTitle = projectCards.nth(1).getByRole("heading", { name: longContextProjectName });
	const longDescription = projectCards.nth(1).getByText(longContextProjectDescription, {
		exact: true,
	});
	expect(await longTitle.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
		true,
	);
	const descriptionTruncation = await longDescription.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			lineClamp: style.webkitLineClamp,
			overflow: style.overflow,
			isVerticallyTruncated: element.scrollHeight > element.clientHeight,
			hasHorizontalOverflow: element.scrollWidth > element.clientWidth + 1,
		};
	});
	expect(descriptionTruncation).toEqual({
		lineClamp: "2",
		overflow: "hidden",
		isVerticallyTruncated: true,
		hasHorizontalOverflow: false,
	});
	await expect(projectCards.nth(1).getByText(longContextProjectSlug, { exact: true })).toHaveCount(
		0,
	);
	expect(
		await projectStack.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	expect(
		await page
			.locator("html")
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	await projectStack.screenshot({
		path: testInfo.outputPath("connected-agent-projects-mobile.png"),
	});
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke");
	await expect(page).toHaveURL(
		/\/agents\/11111111-1111-4111-8111-111111111111\/project-access\/project-smoke$/,
	);
	await expect(main.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Projects", exact: true })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access",
	);
	await expect(main.getByRole("button", { name: "Manage in resource library" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Add to agent/i })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "People", exact: true })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Agents", exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Install skill", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Attach vault", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Add keys to Scoped Vault" })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Skills", exact: true })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
	);
	await expect(main.getByRole("button", { name: "View all Vaults", exact: true })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/vaults",
	);
	await expect(main.getByText("Primary-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Workflow", { exact: true })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Scoped Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Team Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("link", { name: "Open Primary-only Skill" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/skills/primary-only?project=project-smoke",
	);
	await expect(main.getByRole("link", { name: "Open vault Scoped Vault" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	);
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
	);
	const focusedSkillsHeading = main.getByRole("heading", { name: "Skills", level: 1 });
	await expect(focusedSkillsHeading).toBeVisible();
	await expect(page).toHaveTitle("Skills · Clawdi");
	await expect(main.getByText("Project: Smoke Project", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Back to Agent Overview" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111",
	);
	await expect(
		focusedSkillsHeading.locator("xpath=../../..").locator(".bg-identity-2-bg svg.lucide-sparkles"),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Skills", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Vaults", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "View all Skills" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Install skill", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "Add skill", exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Attach Vault/i })).toHaveCount(0);
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-skills-mobile.png") });
	await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
	const mobileProjectSidebar = page.getByRole("dialog");
	await expect(mobileProjectSidebar).toBeVisible();
	await expect(
		mobileProjectSidebar.getByRole("group", { name: "Workspace", exact: true }),
	).toBeVisible();
	await expect(
		mobileProjectSidebar.getByRole("link", { name: "Skills", exact: true }),
	).toHaveAttribute("data-active", "");
	await expect(
		mobileProjectSidebar.getByRole("link", { name: "Vaults", exact: true }),
	).not.toHaveAttribute("data-active", "");
	await page.waitForTimeout(250);
	await page.screenshot({
		path: testInfo.outputPath("connected-workspace-sidebar-mobile.png"),
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1280, height: 1200 });
	await expect(
		page
			.getByRole("navigation", { name: "breadcrumb" })
			.locator('[data-slot="breadcrumb-item"]:visible'),
	).toHaveText(["Smoke Codex", "Skills"]);
	await expect(main.getByRole("button", { name: "Back to Agent Overview" })).toHaveCount(0);
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-skills-desktop.png") });
	await page.screenshot({
		path: testInfo.outputPath("connected-workspace-sidebar-desktop.png"),
		fullPage: true,
	});

	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/vaults",
	);
	const focusedVaultsHeading = main.getByRole("heading", { name: "Vaults", level: 1 });
	await expect(focusedVaultsHeading).toBeVisible();
	await expect(page).toHaveTitle("Vaults · Clawdi");
	await expect(
		page
			.getByRole("navigation", { name: "breadcrumb" })
			.locator('[data-slot="breadcrumb-item"]:visible'),
	).toHaveText(["Smoke Codex", "Vaults"]);
	await expect(main.getByText("Project: Smoke Project", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Back to Agent Overview" })).toHaveCount(0);
	await expect(
		focusedVaultsHeading.locator("xpath=../../..").locator(".bg-identity-4-bg svg.lucide-key"),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Vaults", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("heading", { name: "Skills", level: 2 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "View all Vaults" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /Install skill/i })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Attach vault", exact: true })).toBeVisible();
	const desktopWorkspace = page
		.getByTestId("app-sidebar")
		.getByRole("group", { name: "Workspace", exact: true });
	await expect(desktopWorkspace.getByRole("link", { name: "Vaults", exact: true })).toHaveAttribute(
		"data-active",
		"",
	);
	await expect(
		desktopWorkspace.getByRole("link", { name: "Skills", exact: true }),
	).not.toHaveAttribute("data-active", "");
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-vaults-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await main.screenshot({ path: testInfo.outputPath("connected-workspace-vaults-mobile.png") });

	await page.setViewportSize({ width: 1280, height: 1200 });
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-first",
	);
	await expect(main.getByRole("heading", { name: "Team Knowledge", level: 1 })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Workflow", { exact: true })).toBeVisible();
	await expect(main.getByText("Primary-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByText("Team Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Shared Vault", { exact: true })).toBeVisible();
	await expect(main.getByText("Scoped Vault", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("link", { name: "Open Team-only Skill" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/skills/team-only?project=project-context-first",
	);
	await expect(main.getByRole("link", { name: "Open vault Team Vault" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/vaults/team-vault?project=project-context-first&vault=vault-team",
	);
	await expect(main.getByRole("button", { name: "View all Skills", exact: true })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-first/skills",
	);
	await expect(main.getByRole("button", { name: "View all Vaults", exact: true })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-first/vaults",
	);
	await main.getByRole("button", { name: "View all Skills", exact: true }).click();
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-first/skills",
	);
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "breadcrumb" })
			.locator('[data-slot="breadcrumb-item"]:visible'),
	).toHaveText(["Smoke Codex", "Projects", "Team Knowledge", "Skills"]);
	await expect(main.getByRole("button", { name: "Back to Team Knowledge" })).toHaveCount(0);
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-later",
	);
	await expect(main.getByRole("heading", { name: longContextProjectName, level: 1 })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Skills" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-later/skills",
	);
	await expect(main.getByRole("button", { name: "Add skill", exact: true })).toBeVisible();
	await expect(main.getByRole("button", { name: "View all Vaults" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-later/vaults",
	);
	await expect(main.getByRole("button", { name: "Attach vault", exact: true })).toBeVisible();
	const requestsBeforeInvalidScope = skillRequests.length;
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-unrelated/skills",
	);
	await expect(
		main.getByText("Project not available to this Agent", { exact: true }),
	).toBeVisible();
	await expect(main.getByRole("button", { name: "Back to Projects" })).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access",
	);
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toHaveCount(0);
	expect(skillRequests).toHaveLength(requestsBeforeInvalidScope);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/projects");
	await expect(main.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
	const consoleProjectGrid = main.getByTestId("project-grid");
	const consoleSharedProject = consoleProjectGrid.getByRole("link", {
		name: "Open Team Knowledge",
	});
	await expect(consoleSharedProject).toHaveAttribute("href", "/projects/project-context-first");
	await expect(consoleSharedProject.locator("xpath=..")).toContainText("Viewer");
	await expect(consoleProjectGrid.getByText("Custom Project", { exact: true })).toHaveCount(0);
	await expect(consoleProjectGrid.getByText("Owner", { exact: true })).toHaveCount(0);
	await expect(consoleProjectGrid).not.toContainText("undefined skills");
	await expect(consoleProjectGrid).not.toContainText("undefined vaults");
	await expect(main.getByRole("link", { name: "Open Smoke Project" })).toHaveCount(0);
	await main.screenshot({ path: testInfo.outputPath("console-projects-desktop.png") });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	await main.screenshot({ path: testInfo.outputPath("console-projects-dark.png") });
	await page.locator("html").evaluate((element) => element.classList.remove("dark"));
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(consoleSharedProject).toBeVisible();
	expect(
		await page
			.locator("html")
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
	).toBe(true);
	await main.screenshot({ path: testInfo.outputPath("console-projects-mobile.png") });
});

test("agent scoped Skills and Vaults preserve context for mutations", async ({ page }) => {
	const { longContextProjectName, skillCreateRequests, vaultRequests, vaultItemWriteRequests } =
		await stubConnectedAgentResources(page);
	const main = page.locator("main");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/skills");
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
	);
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/skills?project=project-context-first",
	);
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-first/skills",
	);
	await expect(main.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
	await expect(main.getByText("Project: Team Knowledge", { exact: true })).toBeVisible();
	await expect(main.getByText("Team-only Skill", { exact: true })).toBeVisible();
	await expect(main.getByText("Primary-only Skill", { exact: true })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Add skill", exact: true })).toHaveCount(0);
	expect(vaultRequests).toEqual([]);
	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-later/skills",
	);
	await expect(main.getByText(`Project: ${longContextProjectName}`, { exact: true })).toBeVisible();
	const addSkillButton = main.getByRole("button", { name: "Add skill", exact: true });
	await expect(addSkillButton).toBeVisible();
	await addSkillButton.click();
	const addSkillDialog = page.getByRole("dialog", { name: "Add skill" });
	await addSkillDialog.getByLabel("Name").fill("Release checklist");
	await addSkillDialog
		.getByLabel("Instructions")
		.fill("Review the release checklist before deploy.");
	await addSkillDialog.getByRole("button", { name: "Add skill", exact: true }).click();
	await expect(addSkillDialog).toHaveCount(0);
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-context-later/skills",
	);
	await expect
		.poll(() => skillCreateRequests)
		.toEqual([
			{
				projectId: "project-context-later",
				body: {
					name: "Release checklist",
					description: null,
					instructions: "Review the release checklist before deploy.",
				},
			},
		]);
	await expect(main.getByRole("button", { name: /Attach Vault/i })).toHaveCount(0);

	await page.goto("/agents/11111111-1111-4111-8111-111111111111/vaults");
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/vaults",
	);
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/vaults?project=project-unrelated");
	await expect(page).toHaveURL("/agents/11111111-1111-4111-8111-111111111111/project-access");
	await page.goto("/agents/11111111-1111-4111-8111-111111111111/vaults?project=project-smoke");
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/vaults",
	);
	await expect(main.getByRole("heading", { name: "Vaults", level: 1 })).toBeVisible();
	const scopedVaultLink = main.getByRole("link", { name: "Open vault Scoped Vault" });
	await scopedVaultLink.click();
	await expect(page).toHaveURL(
		/\/agents\/11111111-1111-4111-8111-111111111111\/vaults\/scoped-vault\?project=project-smoke&vault=vault-scoped$/,
	);
	await expect(main.getByRole("heading", { name: "Scoped Vault", level: 1 })).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "breadcrumb" })
			.locator('[data-slot="breadcrumb-item"]:visible'),
	).toHaveText(["Smoke Codex", "Vaults", "Scoped Vault"]);
	await expect(main.getByRole("button", { name: "Vaults" })).toHaveCount(0);
	await expect(
		main
			.getByRole("navigation", { name: "breadcrumb" })
			.getByRole("link", { name: "Vaults", exact: true }),
	).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/vaults",
	);
	await expect(main.getByRole("button", { name: "Open in resource library" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: /^Delete$/ })).toBeVisible();
	const addKeysButton = main.getByRole("button", { name: "Add keys", exact: true });
	await expect(addKeysButton).toBeVisible();
	await addKeysButton.click();
	const addKeysDialog = page.getByRole("dialog", { name: "Add keys" });
	await addKeysDialog.getByRole("textbox").fill("DEPLOY_TOKEN=secret-value");
	await addKeysDialog.getByRole("button", { name: "Save 1" }).click();
	await expect(addKeysDialog).toHaveCount(0);
	await expect.poll(() => vaultItemWriteRequests).toHaveLength(1);
	const vaultWrite = vaultItemWriteRequests[0];
	expect(vaultWrite?.body).toEqual({ section: "", fields: { DEPLOY_TOKEN: "secret-value" } });
	const vaultWriteUrl = new URL(vaultWrite?.url ?? "http://invalid");
	expect(vaultWriteUrl.searchParams.get("project_id")).toBe("project-smoke");
	expect(vaultWriteUrl.searchParams.get("vault_id")).toBe("vault-scoped");
	await expect(page).toHaveURL(
		"/agents/11111111-1111-4111-8111-111111111111/vaults/scoped-vault?project=project-smoke&vault=vault-scoped",
	);
	await expect(main.getByRole("link", { name: "Workspace" }).last()).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke",
	);
	const requestedVaultProjectIds = vaultRequests.map((request) =>
		new URL(request).searchParams.get("project_id"),
	);
	expect(requestedVaultProjectIds).toContain("project-smoke");
	expect(requestedVaultProjectIds).not.toContain("project-context-first");
	expect(requestedVaultProjectIds).not.toContain(null);
	expect(requestedVaultProjectIds).not.toContain("project-unrelated");
});

test("Workspace Skills fail closed on Project binding errors without reading Skills", async ({
	page,
}) => {
	const skillRequests: string[] = [];
	await stubDashboardApi(page, [], {
		projectBindingsError: { status: 503, detail: "bindings unavailable" },
		skillRequests,
	});

	await page.goto(
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
	);
	const main = page.locator("main");
	await expect(
		main.getByText("Couldn't verify Workspace or Project access", { exact: true }),
	).toBeVisible({ timeout: 15_000 });
	// Fail closed: the Workspace rail keeps only its unconditional Projects
	// entry — scoped Skills/Vaults items stay hidden while bindings error.
	const workspaceGroup = page
		.getByTestId("app-sidebar")
		.getByRole("group", { name: "Workspace", exact: true });
	await expect(workspaceGroup.getByRole("link")).toHaveText(["Projects"]);
	expect(skillRequests).toEqual([]);
});

test("agent Skill details resolve only through effective Projects", async ({ page }) => {
	let releaseBindings: (() => void) | undefined;
	const projectBindingsGate = new Promise<void>((resolve) => {
		releaseBindings = resolve;
	});
	const skillDetailRequests: string[] = [];
	const legacySkillDetailRequests: string[] = [];
	const contextProjectId = "project-context";
	const scopedSkill = {
		id: "skill-scoped",
		skill_key: "scoped-skill",
		name: "Scoped Skill",
		description: "Available through the primary Project",
		version: 1,
		source: "cloud",
		authority: "cloud",
		source_repo: null,
		file_count: 1,
		content: "Follow the scoped instructions.\n",
		agent_types: ["codex"],
		created_at: now.toISOString(),
		content_hash: "a".repeat(64),
		updated_at: now.toISOString(),
		project_id: "project-smoke",
		project_name: "Smoke Project",
		project_kind: "environment",
		environment_id: "11111111-1111-4111-8111-111111111111",
		machine_name: "smoke-machine.local",
	};
	const contextSkill = {
		...scopedSkill,
		id: "skill-context",
		skill_key: "context-only",
		name: "Context-only Skill",
		description: "Available through an added Project",
		content: "Follow the context instructions.\n",
		project_id: contextProjectId,
		project_name: "Context Project",
		project_kind: "workspace",
		environment_id: null,
		machine_name: null,
	};
	await stubDashboardApi(page, [], {
		projectBindingsGate,
		projectBindings: [
			...projectBindings,
			{
				id: "binding-context",
				agent_id: "11111111-1111-4111-8111-111111111111",
				project_id: contextProjectId,
				binding_type: "context",
				priority: 1,
				default_write_enabled: false,
				created_at: now.toISOString(),
			},
		],
		projects: [
			...projects,
			{
				id: contextProjectId,
				name: "Context Project",
				slug: "context-project",
				kind: "workspace",
				origin_environment_id: null,
				archived_at: null,
				created_at: now.toISOString(),
				is_owner: true,
				owner_display: "Dev User",
				owner_handle: "dev-user",
			},
		],
		skillDetailRequests,
		legacySkillDetailRequests,
		skillDetailResponses: {
			"project-smoke/scoped-skill": { body: scopedSkill, status: 200 },
			[`${contextProjectId}/context-only`]: { body: contextSkill, status: 200 },
		},
	});

	const routeQuery = "keep=state";
	await page.goto(
		`/agents/11111111-1111-4111-8111-111111111111/skills/scoped-skill?project=project-smoke&${routeQuery}`,
	);
	const main = page.locator("main");
	expect(skillDetailRequests).toEqual([]);
	if (!releaseBindings) throw new Error("Project binding gate was not initialized");
	releaseBindings();
	await expect.poll(() => skillDetailRequests.length).toBe(1);
	await expect(main.getByRole("heading", { name: "Scoped Skill", level: 1 })).toBeVisible();
	await expect(
		page
			.getByRole("navigation", { name: "breadcrumb" })
			.locator('[data-slot="breadcrumb-item"]:visible'),
	).toHaveText(["Smoke Codex", "Skills", "Scoped Skill"]);
	await expect(main.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Manage in resource library" })).toHaveCount(0);
	const agentSkillsLink = main
		.getByRole("navigation", { name: "breadcrumb" })
		.getByRole("link", { name: "Skills", exact: true });
	await expect(agentSkillsLink).toHaveAttribute(
		"href",
		"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
	);
	expect(
		skillDetailRequests.some(
			(request) => new URL(request).pathname === "/v1/projects/project-smoke/skills/scoped-skill",
		),
	).toBe(true);
	expect(legacySkillDetailRequests).toEqual([]);

	const requestsBeforeTamperedProject = skillDetailRequests.length;
	await page.goto(
		`/agents/11111111-1111-4111-8111-111111111111/skills/scoped-skill?project=project-unrelated&${routeQuery}`,
	);
	await expect(
		main.getByText("Project not available to this Agent", { exact: true }),
	).toBeVisible();
	await expect(main.getByRole("heading", { name: "Scoped Skill", level: 1 })).toHaveCount(0);
	await expect(main.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
	expect(skillDetailRequests).toHaveLength(requestsBeforeTamperedProject);
	expect(legacySkillDetailRequests).toEqual([]);

	await page.goto(
		`/agents/11111111-1111-4111-8111-111111111111/skills/context-only?project=${contextProjectId}&${routeQuery}`,
	);
	await expect(main.getByRole("heading", { name: "Context-only Skill", level: 1 })).toBeVisible();
	const contextRequests = skillDetailRequests.filter((request) =>
		new URL(request).pathname.endsWith("/skills/context-only"),
	);
	expect(contextRequests.map((request) => new URL(request).pathname)).toEqual([
		`/v1/projects/${contextProjectId}/skills/context-only`,
	]);
	expect(legacySkillDetailRequests).toEqual([]);

	const requestsBeforeMissingProject = skillDetailRequests.length;
	await page.goto(`/agents/11111111-1111-4111-8111-111111111111/skills/context-only?${routeQuery}`);
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === "/agents/11111111-1111-4111-8111-111111111111/skills/context-only" &&
			url.searchParams.get("project") === "project-smoke" &&
			!url.searchParams.has("keep") &&
			!url.searchParams.has("source") &&
			!url.searchParams.has("d")
		);
	});
	await expect(main.getByText("Skill not found", { exact: true })).toBeVisible();
	expect(skillDetailRequests).toHaveLength(requestsBeforeMissingProject + 1);
	expect(new URL(skillDetailRequests.at(-1) ?? "").pathname).toBe(
		"/v1/projects/project-smoke/skills/context-only",
	);

	await page.goto(
		`/agents/11111111-1111-4111-8111-111111111111/skills/missing-skill?project=${contextProjectId}&${routeQuery}`,
	);
	await expect(main.getByText("Skill not found", { exact: true })).toBeVisible();
	await expect(main.getByText("This Skill was not found in this Agent's Projects.")).toBeVisible();
	expect(legacySkillDetailRequests).toEqual([]);

	const errorPage = await page.context().newPage();
	const errorSkillDetailRequests: string[] = [];
	try {
		await stubDashboardApi(errorPage, [], {
			projectBindingsError: { status: 503, detail: "bindings unavailable" },
			skillDetailRequests: errorSkillDetailRequests,
		});
		await errorPage.goto(
			`/agents/11111111-1111-4111-8111-111111111111/skills/scoped-skill?project=project-smoke&${routeQuery}`,
		);
		const errorMain = errorPage.locator("main");
		await expect(
			errorMain.getByText("Couldn't verify Workspace or Project access", { exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await expect(errorMain.getByRole("button", { name: "Agent Skills" })).toHaveCount(0);
		await expect(
			errorMain
				.getByRole("navigation", { name: "breadcrumb" })
				.getByRole("link", { name: "Skills", exact: true }),
		).toHaveAttribute(
			"href",
			"/agents/11111111-1111-4111-8111-111111111111/project-access/project-smoke/skills",
		);
		expect(errorSkillDetailRequests).toEqual([]);
	} finally {
		await errorPage.close();
	}
});

test("agent rail preserves keyboard sorting and primes agent switches", async ({ page }) => {
	const agentOrderRequests: string[] = [];
	const agentDetailRequests: string[] = [];
	await stubDashboardApi(page, agentOrderRequests, { agentDetailRequests });
	await page.goto("/");

	const tiles = page.getByTestId("app-sidebar-agent-tile");
	await expect(tiles).toHaveCount(2, { timeout: 15_000 });
	await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0);
	const firstTile = tiles.filter({ hasText: "Smoke Codex" });
	const firstButton = firstTile.locator("button");
	const firstTileBox = await firstTile.boundingBox();
	const firstButtonBox = await firstButton.boundingBox();
	if (!firstTileBox || !firstButtonBox) throw new Error("Agent rail tile should be interactive.");
	expect(firstTileBox.height).toBeCloseTo(68, 0);
	expect(firstButtonBox.height).toBeCloseTo(firstTileBox.height, 0);
	expect(firstButtonBox.width).toBeCloseTo(firstTileBox.width, 0);

	await firstButton.focus();
	await page.keyboard.down("Space");
	await expect(firstButton).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.up("Space");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await expect(firstButton).not.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	expect(agentOrderRequests).toEqual([]);
	await expect(tiles.nth(0)).toContainText("Smoke Codex");

	await firstButton.focus();
	await page.keyboard.down("Space");
	await expect(firstButton).toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	await page.keyboard.up("Space");
	await expect(page).toHaveURL("/");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.down("Space");
	await expect(firstButton).not.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL("/");
	await page.keyboard.up("Space");

	await expect(page).toHaveURL("/");
	await expect.poll(() => agentOrderRequests.length).toBe(1);
	expect(JSON.parse(agentOrderRequests[0] ?? "{}")).toEqual({
		agent_ids: ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"],
	});
	await expect(tiles.nth(0)).toContainText("Smoke Hermes");

	const postDragTarget = tiles.filter({ hasText: "Smoke Hermes" }).locator("button");
	await postDragTarget.click();
	await expect(page).toHaveURL("/agents/22222222-2222-4222-8222-222222222222");
	await expect(page.getByRole("heading", { name: "Smoke Hermes", level: 1 })).toBeVisible();
	expect(agentDetailRequests).toEqual([]);
});
