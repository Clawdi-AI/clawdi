import { beforeEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaded = <T,>(data: T) => ({
	data,
	error: null,
	isError: false,
	isPending: false,
	refetch: async () => undefined,
});

function harness() {
	return {
		agent: loaded({ id: "agent-1", default_project_id: "workspace-1" }),
		bindings: loaded([{ project_id: "workspace-1", binding_type: "primary" }]),
		projects: loaded([
			{ id: "workspace-1", kind: "workspace" },
			{ id: "own-project", kind: "workspace" },
			{ id: "environment-1", kind: "environment" },
		]),
	};
}
let h = harness();

const reactQuery = { ...(await import("@tanstack/react-query")) };
mock.module("@tanstack/react-query", () => ({ ...reactQuery, useQuery: () => h.bindings }));
mock.module("@/hooks/cloud-inventory", () => ({ useCloudAgent: () => h.agent }));
mock.module("@/components/projects/projects-surface", () => ({
	useCloudProjects: () => h.projects,
}));
mock.module("@/components/api-error-panel", () => ({ ApiErrorPanel: () => <p>blocked</p> }));
mock.module("@/components/detail/layout", () => ({
	LibraryPage: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
mock.module("@/components/route-loading-skeleton", () => ({
	RouteLoadingSkeleton: () => <p>loading</p>,
}));
mock.module("@/lib/api-provider", () => ({ useMobileApi: () => ({ agentProjects: {} }) }));
mock.module("@/platform/account-lifecycle", () => ({
	accountQueryKey: (...parts: unknown[]) => parts,
	useAccountScope: () => ({ isReady: true }),
	useAccountRead: () => () => undefined,
}));

const { AgentResourceRouteGate } = await import("./agent-resource-route-gate");

const render = (projectId: string) =>
	renderToStaticMarkup(
		<AgentResourceRouteGate agentId="agent-1" projectId={projectId}>
			{(project) => <p>open {project}</p>}
		</AgentResourceRouteGate>,
	);

beforeEach(() => {
	h = harness();
});

test("opens the user's own Project under the Agent route without a link, as Web does", () => {
	expect(render("own-project")).toBe("<p>open own-project</p>");
	expect(render("workspace-1")).toBe("<p>open workspace-1</p>");
});

test("still blocks an unlinked Project that isn't the user's own workspace project", () => {
	expect(render("environment-1")).toBe("<p>blocked</p>");
	expect(render("someone-else")).toBe("<p>blocked</p>");
});

test("waits for the Project list before deciding an unlinked Project", () => {
	h.projects = { ...h.projects, isPending: true, data: [] };
	expect(render("own-project")).toBe("<p>loading</p>");
});
