import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "@/lib/i18n/en";

type Button = { label: string; disabled?: boolean; onPress?: () => unknown };

// A not-yet-observed Skill keeps the inventory polling in the background.
const polling = {
	skills: [
		{ skill_key: "pending", name: "Pending", source: "library", convergence: "not_observed" },
	],
};

function harness() {
	return {
		inventory: {
			data: polling as typeof polling | undefined,
			error: null as unknown,
			isError: false,
			isPending: false,
			isFetching: true,
			isRefetching: true,
			refetch: mock(async () => undefined),
		},
		buttons: [] as Button[],
		errorPanels: [] as { title?: string; onRetry?: () => void }[],
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
	useQuery: (...args: Parameters<typeof reactQuery.useQuery>) =>
		active ? h.inventory : reactQuery.useQuery(...args),
}));
mock.module("expo-router", () => ({
	Stack: { Screen: () => null },
	useLocalSearchParams: () => ({ id: "agent-1" }),
	useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
mock.module("expo-router/react-navigation", () => ({ useIsFocused: () => true }));
mock.module("@/components/api-error-panel", () => ({
	ApiErrorPanel: (props: { title?: string; onRetry?: () => void }) => {
		h.errorPanels.push(props);
		return null;
	},
}));
mock.module("@/components/dashboard/collection", () => ({ AgentCollection: passthrough }));
mock.module("@/components/dashboard/confirmation", () => ({
	useAgentConfirmation: () => ({ request: () => undefined, dialog: null }),
}));
mock.module("@/components/dashboard/controls", () => ({
	ActionButton: (props: Button) => {
		h.buttons.push(props);
		return null;
	},
}));
mock.module("@/components/dashboard/navigation", () => ({ AgentSectionNavigation: () => null }));
mock.module("@/components/empty-state", () => ({ EmptyState: () => null }));
mock.module("@/components/entity-card", () => ({
	HeroCard: ({ actions }: { actions?: ReactNode }) => <>{actions}</>,
	HeroCardSkeleton: () => null,
}));
mock.module("@/components/icon-chip", () => ({ IconChip: passthrough }));
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
mock.module("@/lib/api-provider", () => ({
	useMobileApi: () => ({ agentExtensions: { setLibraryReference: h.setLibraryReference } }),
}));
mock.module("@/pages/dashboard/skills/page", () => ({
	useCloudSkills: () => ({
		data: { pages: [{ items: [{ id: "skill-1", name: "Demo", authority: "cloud" }] }] },
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
