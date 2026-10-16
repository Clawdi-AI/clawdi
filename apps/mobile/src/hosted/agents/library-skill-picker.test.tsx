import { afterAll, beforeEach, expect, jest, mock, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import { agentSurfaceCopy } from "@clawdi/shared/view";
import {
	environmentManager,
	focusManager,
	QueryClient,
	QueryObserver,
	type QueryObserverOptions,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "@/lib/i18n/en";

type Button = { label: string; disabled?: boolean; onPress?: () => unknown; row?: string };
type Confirmation = {
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => unknown;
};
type ManagedSkill = {
	skill_key: string;
	name: string;
	source: "github" | "library" | "project" | "bundled";
	convergence: "installed" | "not_observed" | "failed";
	read_only?: boolean;
	skill_id?: string | null;
	project_id?: string | null;
	source_skill_key?: string | null;
	observation_error_code?: string | null;
};
type Inventory = { skills: ManagedSkill[]; removal_failures?: unknown[] };
type CloudSkill = components["schemas"]["SkillSummaryResponse"];
type LibrarySkill = {
	id: string;
	name: string;
	authority: CloudSkill["authority"];
	description?: string | null;
};

const skill = (overrides: Partial<ManagedSkill> & Pick<ManagedSkill, "skill_key">) =>
	({
		name: overrides.skill_key,
		source: "library",
		convergence: "installed",
		read_only: false,
		...overrides,
	}) satisfies ManagedSkill;

// A not-yet-observed Skill keeps the inventory polling in the background.
const polling: Inventory = {
	skills: [skill({ skill_key: "pending", name: "Pending", convergence: "not_observed" })],
};

const githubSource = { url: "https://github.com/acme/skills", path: "brand-guidelines" };

function harness() {
	const library: LibrarySkill[] = [{ id: "skill-1", name: "Demo", authority: "cloud" }];
	return {
		projections: {
			workspace: "workspace-1" as string | null,
			data: [] as { skill_key: string; name: string; authority: "agent_sync" }[],
			error: null as unknown,
			refetch: mock(() => undefined),
		},
		inventory: {
			data: polling as Inventory | undefined,
			error: null as unknown,
			isError: false,
			isPending: false,
			isFetching: true,
			isRefetching: true,
			refetch: mock(async () => undefined),
		},
		queries: [] as QueryObserverOptions[],
		focused: true,
		library,
		projects: {
			data: [
				{ id: "environment-1", kind: "environment" },
				{ id: "workspace-1", kind: "workspace" },
			],
			error: null as unknown,
			isError: false,
			isPending: false,
			isRefetching: false,
			refetch: mock(async () => undefined),
		},
		cloudListSkills: mock(
			async (
				_query: { project_id?: string; page?: number; page_size?: number; q?: string },
				_signal?: AbortSignal,
			): Promise<{ items: CloudSkill[]; total: number; page: number; page_size: number }> => ({
				items: [],
				total: 0,
				page: 1,
				page_size: 200,
			}),
		),
		changes: {
			inventory: {
				data: { items: [{ skill_key: "brand-guidelines", source: githubSource }] } as
					| { items: { skill_key: string; source: typeof githubSource }[] }
					| undefined,
				refetch: async () => undefined,
			},
			deployment: { refetch: async () => undefined },
			enabled: true,
			busy: false,
			journaled: false,
			prepare: mock((_mutation: unknown, _name?: string) => undefined),
			journal: null,
			dialog: null,
		},
		row: "",
		buttons: [] as Button[],
		confirmations: [] as Confirmation[],
		errorPanels: [] as { title?: string; onRetry?: () => void }[],
		listSkills: mock(
			async (_agentId: string, _signal?: AbortSignal): Promise<Inventory> => polling,
		),
		setLibraryReference: mock(
			async (_agentId: string, _skillId: string, _present: boolean, _signal?: AbortSignal) =>
				undefined,
		),
		close: mock(async (_result?: boolean) => undefined),
		pushes: [] as unknown[],
		controller: new AbortController(),
	};
}

let h: ReturnType<typeof harness>;
let active = true;
const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
// Bun's module mocks last for the whole run: keep every real export, and let useQuery fall
// back to the real hook once this file's tests are done.
const reactQuery = { ...(await import("@tanstack/react-query")) };
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useQuery: (...args: Parameters<typeof reactQuery.useQuery>) => {
		if (!active) return reactQuery.useQuery(...args);
		const options = args[0] as QueryObserverOptions;
		h.queries.push(options);
		if (options.queryKey?.includes("library-picker-skills"))
			return {
				data: h.library,
				error: null,
				isError: false,
				isPending: false,
				isFetching: false,
				isRefetching: false,
				refetch: async () => undefined,
			};
		return h.inventory;
	},
}));
mock.module("expo-router", () => ({
	Stack: { Screen: () => null, SearchBar: () => null },
	useLocalSearchParams: () => ({ id: "agent-1" }),
	useRouter: () => ({ push: (href: unknown) => h.pushes.push(href), replace: () => undefined }),
}));
mock.module("expo-router/react-navigation", () => ({ useIsFocused: () => h.focused }));
mock.module("@/components/api-error-panel", () => ({
	ApiErrorPanel: (props: { title?: string; onRetry?: () => void }) => {
		h.errorPanels.push(props);
		return null;
	},
}));
mock.module("@/components/dashboard/collection", () => ({
	AgentCollection: ({
		data,
		renderItem,
		children,
	}: {
		data: unknown[];
		renderItem: (info: { item: unknown }) => ReactNode;
		children?: ReactNode;
	}) => (
		<>
			{children}
			{data.map((item) => renderItem({ item }))}
		</>
	),
}));
mock.module("@/components/dashboard/confirmation", () => ({
	useAgentConfirmation: () => ({
		request: (confirmation: Confirmation) => h.confirmations.push(confirmation),
		dialog: null,
	}),
}));
mock.module("@/components/dashboard/controls", () => ({
	ActionButton: (props: Button) => {
		h.buttons.push({ ...props, row: h.row });
		return null;
	},
}));
mock.module("@/components/dashboard/navigation", () => ({ AgentSectionNavigation: () => null }));
mock.module("@/components/empty-state", () => ({
	EmptyState: ({ title }: { title?: ReactNode }) => <p>{title}</p>,
}));
mock.module("@/components/entity-card", () => ({
	HeroCard: ({
		title,
		footer,
		actions,
		children,
	}: {
		title: string;
		footer?: string[];
		actions?: ReactNode;
		children?: ReactNode;
	}) => {
		h.row = title;
		return (
			<p>
				{title}|{footer?.join("|")}|{actions}
				{children}
			</p>
		);
	},
	HeroCardSkeleton: () => null,
}));
mock.module("@/components/icon-chip", () => ({ IconChip: () => null }));
mock.module("@/components/projects/projects-surface", () => ({
	useCloudProjects: () => h.projects,
}));
mock.module("@/components/ui/alert", () => ({
	Alert: ({ title, children }: { title?: ReactNode; children?: ReactNode }) => (
		<aside>
			{title}|{children}
		</aside>
	),
}));
mock.module("@/components/ui/badge", () => ({ Badge: passthrough }));
mock.module("@/components/ui/native-list", () => ({
	NativeList: <T,>({
		data,
		header,
		renderItem,
	}: {
		data: T[];
		header?: ReactNode;
		renderItem: (info: { item: T }) => ReactNode;
	}) => (
		<>
			{header}
			{data.map((item) => renderItem({ item }))}
		</>
	),
}));
mock.module("@/components/ui/text", () => ({ Text: passthrough }));
mock.module("@/components/ui/web-layout", () => ({ WebView: passthrough }));
mock.module("@/components/skills/skill-card", () => ({
	SkillCard: ({
		skill,
		provenanceLabel,
	}: {
		skill: { name: string };
		provenanceLabel?: string;
	}) => (
		<p>
			{skill.name}|{provenanceLabel}
		</p>
	),
}));
mock.module("@/hosted/agents/agent-workspace-projections-query", () => ({
	useAgentWorkspaceProjections: () => h.projections,
}));
mock.module("@/hosted/agents/workspace-skill-changes", () => ({
	useWorkspaceSkillChanges: () => h.changes,
}));
mock.module("@/lib/api-provider", () => ({
	useMobileApi: () => ({
		agentExtensions: { listSkills: h.listSkills, setLibraryReference: h.setLibraryReference },
		cloud: { listSkills: h.cloudListSkills },
	}),
}));
mock.module("@/platform/account-lifecycle", () => ({
	accountQueryKey: (...parts: unknown[]) => parts,
	useAccountScope: () => ({
		identity: "owner",
		accountKey: "account",
		generation: 1,
		isReady: true,
		signal: h.controller.signal,
		isCurrent: () => true,
	}),
	useAccountRead: () => (read: (signal: AbortSignal) => unknown) => read(h.controller.signal),
}));
mock.module("@/platform/auth/use-auth-action", () => ({
	useAuthAction: () => {
		const run = (action: (current: () => boolean) => Promise<void>) => action(() => true);
		return { busy: false, error: null, run, runOrThrow: run };
	},
}));
mock.module("@/platform/navigation/native-header", () => ({
	NativeHeader: () => null,
	useHeaderSearch: () => ({}),
}));
mock.module("@/platform/navigation/segmented-control", () => ({ NativeSegments: () => null }));
mock.module("@/platform/navigation/sheet-options", () => ({ sheetCancelHeaderOptions: {} }));
mock.module("@/platform/navigation/use-sheet", () => ({ useSheet: () => ({ close: h.close }) }));
mock.module("@/platform/safe-area-screen", () => ({ SafeAreaScreen: passthrough }));
mock.module("@/platform/use-foreground-lease", () => ({
	useForegroundLease: () => () => () => true,
}));

const { HostedAgentLibrarySkillsScreen } = await import("./library-skill-picker");

const install = () => h.buttons.find((button) => button.label === en.agentExtensions.install);
const uninstallRows = () =>
	h.buttons
		.filter((button) => button.label === en.workspaceSkills.uninstallAction)
		.map((button) => button.row);
// Static markup escapes apostrophes.
const html = (text: string) => text.replaceAll("'", "&#x27;");
const flush = async () => {
	for (let i = 0; i < 5; i++) {
		jest.advanceTimersByTime(0);
		await Promise.resolve();
	}
};

function cloudSkill(
	id: string,
	name: string,
	projectId: string,
	authority: CloudSkill["authority"],
): CloudSkill {
	return {
		id,
		skill_key: id,
		name,
		description: null,
		version: 1,
		source: "cloud",
		authority,
		source_repo: null,
		agent_types: null,
		file_count: 1,
		content_hash: "a".repeat(64),
		is_active: true,
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-01T00:00:00Z",
		project_id: projectId,
		project_name: projectId,
		project_kind: projectId === "workspace-1" ? "workspace" : "environment",
	};
}

/** Runs the list's own Skills query options against a real QueryClient. */
function observeSkillsQuery() {
	const options = h.queries.find((query) => query.queryKey?.includes("agent-desired-skills"));
	if (!options) throw new Error("Missing Skills query");
	const client = new QueryClient();
	const observer = new QueryObserver(client, options);
	const unsubscribe = observer.subscribe(() => undefined);
	return {
		observer,
		stop: () => {
			unsubscribe();
			client.clear();
		},
	};
}

beforeEach(() => {
	h = harness();
});
afterAll(() => {
	active = false;
});

test("Install stays usable while the inventory polls, sends one PUT and closes the sheet", async () => {
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
	expect(install()?.disabled).toBe(false);
	install()?.onPress?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(h.setLibraryReference).toHaveBeenCalledTimes(1);
	expect(h.setLibraryReference).toHaveBeenCalledWith(
		"agent-1",
		"skill-1",
		true,
		h.controller.signal,
	);
	expect(h.close).toHaveBeenCalledTimes(1);
});

test("a failed inventory load shows Retry in the browse sheet and keeps Install disabled", () => {
	h.inventory = {
		...h.inventory,
		data: undefined,
		error: new Error("Inventory unavailable"),
		isError: true,
		isFetching: false,
	};
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
	expect(install()?.disabled).toBe(true);
	const panel = h.errorPanels.find((item) => item.title === en.workspaceSkills.loadError);
	expect(panel?.onRetry).toBeDefined();
	panel?.onRetry?.();
	expect(h.inventory.refetch).toHaveBeenCalledTimes(1);
});

test("the focused Skills list keeps polling past two minutes until the row shows Installed", async () => {
	const installed: Inventory = {
		skills: [skill({ skill_key: "pending", name: "Pending", convergence: "installed" })],
	};
	// The observation lands only after the old 120 s polling window has passed.
	let elapsed = 0;
	const requestedAt: number[] = [];
	h.listSkills.mockImplementation(async () => {
		requestedAt.push(elapsed);
		return elapsed > 150_000 ? installed : polling;
	});
	jest.useFakeTimers();
	environmentManager.setIsServer(() => false);
	focusManager.setFocused(true);
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	const query = observeSkillsQuery();
	try {
		await flush();
		while (elapsed < 180_000) {
			elapsed += 1_000;
			jest.advanceTimersByTime(1_000);
			await flush();
		}
		expect(requestedAt.some((at) => at > 120_000)).toBe(true);
		expect(query.observer.getCurrentResult().data).toEqual(installed);
		h.inventory.data = installed;
		expect(
			renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />),
		).toContain(`Pending|library|${en.agentExtensions.installed}|`);
	} finally {
		query.stop();
		jest.useRealTimers();
		focusManager.setFocused(undefined);
		environmentManager.setIsServer(() => typeof window === "undefined");
	}
});

test("an unfocused Skills list makes no further requests", async () => {
	h.focused = false;
	jest.useFakeTimers();
	environmentManager.setIsServer(() => false);
	focusManager.setFocused(true);
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	const query = observeSkillsQuery();
	try {
		await flush();
		const calls = h.listSkills.mock.calls.length;
		for (let elapsed = 0; elapsed < 30_000; elapsed += 1_000) {
			jest.advanceTimersByTime(1_000);
			await flush();
		}
		expect(h.listSkills.mock.calls.length).toBe(calls);
	} finally {
		query.stop();
		jest.useRealTimers();
		focusManager.setFocused(undefined);
		environmentManager.setIsServer(() => typeof window === "undefined");
	}
});

test("Library skills a linked Project already provides read Installed and can't be installed", () => {
	h.inventory.data = {
		skills: [skill({ skill_key: "s1", source: "project", skill_id: "s1", read_only: true })],
	};
	h.library = [
		{ id: "s1", name: "Provided", authority: "cloud" },
		{ id: "s2", name: "Other", authority: "cloud" },
	];
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
	const provided = h.buttons.find((button) => button.row === "Provided");
	const other = h.buttons.find((button) => button.row === "Other");
	expect(provided).toMatchObject({ label: en.agentExtensions.installed, disabled: true });
	expect(other).toMatchObject({ label: en.agentExtensions.install, disabled: false });
	provided?.onPress?.();
	expect(h.setLibraryReference).not.toHaveBeenCalled();
});

test("the Library sheet lists workspace cloud skills even when agent-synced skills sort first", async () => {
	const workspaceSkills = [
		cloudSkill("workspace-1", "Workspace One", "workspace-1", "cloud"),
		cloudSkill("workspace-2", "Workspace Two", "workspace-1", "cloud"),
	];
	const agentSkills = Array.from({ length: 25 }, (_, index) =>
		cloudSkill(`agent-${index}`, `Agent Skill ${index}`, "environment-1", "agent_sync"),
	);
	h.cloudListSkills.mockImplementation(async (query) => {
		if (query.project_id === "workspace-1")
			return { items: workspaceSkills, total: 2, page: 1, page_size: query.page_size ?? 200 };
		return {
			items: agentSkills,
			total: agentSkills.length,
			page: 1,
			page_size: query.page_size ?? 200,
		};
	});
	h.library = [];
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
	const options = h.queries.find((query) => query.queryKey?.includes("library-picker-skills"));
	if (!options) throw new Error("Missing Library skills query");
	const query = options as QueryObserverOptions<CloudSkill[]>;
	if (typeof query.queryFn !== "function") throw new Error("Missing Library skills query function");
	const result = await query.queryFn({
		client: new QueryClient(),
		queryKey: query.queryKey,
		signal: h.controller.signal,
		meta: undefined,
		pageParam: undefined,
		direction: undefined,
	});
	h.library = result;
	const markup = renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
	expect(markup).toContain("Workspace One");
	expect(markup).toContain("Workspace Two");
	expect(markup).not.toContain("No Skills found");
	expect(h.cloudListSkills).toHaveBeenCalledTimes(1);
	for (const [queryArgs] of h.cloudListSkills.mock.calls) {
		expect(queryArgs.project_id).toBe("workspace-1");
	}
});

test.each([
	["failed", "guard_blocked", "Blocked by Hermes Skills Guard"],
	["not_observed", null, "Installing…"],
	["installed", null, "Installed"],
] as const)(
	"a desired %s Skill with error %p reads %s in the browse sheet and on the list, and can't be installed",
	(convergence, observation_error_code, label) => {
		const row = skill({
			skill_key: "skill-creator",
			source: "project",
			skill_id: "s1",
			read_only: true,
			convergence,
			observation_error_code,
		});
		h.inventory.data = { skills: [row] };
		h.library = [{ id: "s1", name: "skill-creator", authority: "cloud" }];
		renderToStaticMarkup(<HostedAgentLibrarySkillsScreen browse />);
		const sheetButton = h.buttons.find((button) => button.row === "skill-creator");
		expect(sheetButton).toMatchObject({ label, disabled: true });
		sheetButton?.onPress?.();
		expect(h.setLibraryReference).not.toHaveBeenCalled();
		expect(renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="d" />)).toContain(
			html(`skill-creator|project|${label}|`),
		);
	},
);

test("the Skills list offers Uninstall for GitHub and Library rows with Web's confirmation", async () => {
	h.inventory.data = {
		skills: [
			skill({ skill_key: "brand-guidelines", source: "github" }),
			skill({ skill_key: "x", source: "library", skill_id: "x-id" }),
			skill({ skill_key: "y", source: "project", skill_id: "y-id", read_only: true }),
			skill({ skill_key: "clawdi", source: "bundled", read_only: true }),
		],
	};
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	expect(uninstallRows()).toEqual(["brand-guidelines", "x"]);
	const uninstall = (row: string) =>
		h.buttons.find(
			(button) => button.row === row && button.label === en.workspaceSkills.uninstallAction,
		);

	uninstall("brand-guidelines")?.onPress?.();
	expect(h.changes.prepare).toHaveBeenCalledTimes(1);
	expect(h.changes.prepare).toHaveBeenCalledWith(
		{ action: "uninstall", skillKey: "brand-guidelines" },
		"brand-guidelines",
	);

	uninstall("x")?.onPress?.();
	expect(h.confirmations).toHaveLength(1);
	expect(h.confirmations[0]).toMatchObject({
		title: "Uninstall x from agent?",
		description:
			"This removes the skill from this agent. Your library and other agents keep their copies.",
		confirmLabel: "Uninstall skill",
	});
	await h.confirmations[0]?.onConfirm();
	expect(h.setLibraryReference).toHaveBeenCalledTimes(1);
	expect(h.setLibraryReference).toHaveBeenCalledWith("agent-1", "x-id", false, h.controller.signal);
});

test("GitHub Uninstall waits for the workspace change journal", () => {
	h.inventory.data = { skills: [skill({ skill_key: "brand-guidelines", source: "github" })] };
	h.changes.enabled = false;
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	expect(
		h.buttons.find((button) => button.label === en.workspaceSkills.uninstallAction)?.disabled,
	).toBe(true);
});

test("a reconcile_failed Skill shows Web's automatic retry notice; guard failures keep their own copy", () => {
	const retryNotice = `${en.agentExtensions.updateFailedTitle}|${en.agentExtensions.updateFailed}`;
	h.inventory.data = {
		skills: [
			skill({
				skill_key: "skill-creator",
				source: "project",
				convergence: "failed",
				observation_error_code: "reconcile_failed",
			}),
		],
	};
	const failed = renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="d" />);
	expect(retryNotice).toBe("Couldn't update skills|We'll retry automatically.");
	expect(failed).toContain(html(retryNotice));
	expect(failed).toContain(html(`skill-creator|project|${en.agentExtensions.installFailed}|`));

	h.inventory.data = {
		skills: [
			skill({
				skill_key: "guarded",
				source: "github",
				convergence: "failed",
				observation_error_code: "guard_blocked",
			}),
		],
	};
	const guarded = renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="d" />);
	expect(guarded).not.toContain(html(retryNotice));
	expect(guarded).toContain(html(en.agentExtensions.guardBlockedGitHub));

	h.inventory.data = { skills: [skill({ skill_key: "ready" })] };
	expect(renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="d" />)).not.toContain(
		html(retryNotice),
	);
});

test("the Skills list includes agent-synced workspace skills, as Web's tab and the overview count", () => {
	h.projections.data = [{ skill_key: "plan", name: "Plan", authority: "agent_sync" }];
	const markup = renderToStaticMarkup(
		<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />,
	);
	expect(markup).toContain(`Plan|${agentSurfaceCopy.syncedFromAgent}`);
	expect(markup).toContain("Pending|");
});

test("View Library Skill opens the Library skill inside the agent route", () => {
	h.inventory = {
		...h.inventory,
		data: {
			skills: [
				skill({
					skill_key: "brand",
					name: "Brand",
					skill_id: "skill-1",
					project_id: "own-project",
					source_skill_key: "team/brand",
				}),
			],
		},
	};
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	h.buttons.find((button) => button.label === en.agentExtensions.view)?.onPress?.();
	expect(h.pushes).toEqual([
		{
			pathname: "/agents/[id]/skills/[...key]",
			params: { id: "agent-1", project: "own-project", key: ["team", "brand"] },
		},
	]);
});
