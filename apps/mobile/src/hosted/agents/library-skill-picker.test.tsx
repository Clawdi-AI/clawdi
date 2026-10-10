import { afterAll, beforeEach, expect, jest, mock, test } from "bun:test";
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

function harness() {
	return {
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
		library: [{ id: "skill-1", name: "Demo", authority: "cloud" }],
		changes: {
			inventory: {
				data: { items: [{ skill_key: "brand-guidelines" }] } as
					| { items: { skill_key: string }[] }
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
		h.queries.push(args[0] as QueryObserverOptions);
		return h.inventory;
	},
}));
mock.module("expo-router", () => ({
	Stack: { Screen: () => null },
	useLocalSearchParams: () => ({ id: "agent-1" }),
	useRouter: () => ({ push: () => undefined, replace: () => undefined }),
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
mock.module("@/components/empty-state", () => ({ EmptyState: () => null }));
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
mock.module("@/hosted/agents/workspace-skill-changes", () => ({
	useWorkspaceSkillChanges: () => h.changes,
}));
mock.module("@/lib/api-provider", () => ({
	useMobileApi: () => ({
		agentExtensions: { listSkills: h.listSkills, setLibraryReference: h.setLibraryReference },
	}),
}));
mock.module("@/pages/dashboard/skills/page", () => ({
	useCloudSkills: () => ({
		data: { pages: [{ items: h.library }] },
		isError: false,
		isPending: false,
		isFetching: false,
		isRefetching: false,
		hasNextPage: false,
		refetch: async () => undefined,
		fetchNextPage: async () => undefined,
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
	h.listSkills.mockImplementation(async () =>
		h.listSkills.mock.calls.length > 13 ? installed : polling,
	);
	jest.useFakeTimers();
	environmentManager.setIsServer(() => false);
	focusManager.setFocused(true);
	renderToStaticMarkup(<HostedAgentLibrarySkillsScreen deploymentId="deployment-1" />);
	const query = observeSkillsQuery();
	try {
		await flush();
		expect(h.listSkills).toHaveBeenCalledTimes(1);
		for (let elapsed = 0; elapsed < 180_000; elapsed += 1_000) {
			jest.advanceTimersByTime(1_000);
			await flush();
		}
		expect(h.listSkills.mock.calls.length).toBeGreaterThan(13);
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
	expect(failed).toContain(html(`skill-creator|project|${en.agentExtensions.failedState}|`));

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
