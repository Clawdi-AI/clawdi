import { describe, expect, it } from "bun:test";
import {
	connectorDetailHref,
	decodeResourceRouteParam,
	getProjectResourceDefinition,
	memoryDetailHref,
	PROJECT_RESOURCE_NAV_IDS,
	projectDetailHref,
	projectManagedResourceDefinitions,
	projectResourceDefinitionsForGroup,
	projectResourceHref,
	projectResourcePathLabel,
	projectResourceScopeDescription,
	projectResourceScopeLabel,
	sessionDetailHref,
	skillDetailHref,
} from "./project-resource-model";

describe("project resource model", () => {
	it("builds Project-scoped links only for managed resources", () => {
		expect(projectResourceHref("skills", "proj_1")).toBe("/skills?project=proj_1");
		expect(projectResourceHref("vaults", "proj 1")).toBe("/vault?project=proj%201");
		expect(projectResourceHref("memories", "proj_1")).toBe("/memories");
		expect(projectResourceHref("sessions", "proj_1")).toBe("/sessions");
		expect(projectResourceHref("channels", "proj_1")).toBe("/channels");
	});

	it("builds stable detail links for resource rows", () => {
		expect(projectDetailHref("proj 1")).toBe("/projects/proj%201");
		expect(skillDetailHref("team/foo", "proj 1")).toBe("/skills/team%2Ffoo?project=proj%201");
		expect(skillDetailHref("team/foo")).toBe("/skills/team%2Ffoo");
		expect(sessionDetailHref("session 1")).toBe("/sessions/session%201");
		expect(memoryDetailHref("memory 1")).toBe("/memories/memory%201");
		expect(connectorDetailHref("google drive")).toBe("/connectors/google%20drive");
	});

	it("decodes route params before handing them to typed API clients", () => {
		expect(decodeResourceRouteParam("team%2Ffoo")).toBe("team/foo");
		expect(decodeResourceRouteParam("already-decoded")).toBe("already-decoded");
		expect(decodeResourceRouteParam("%E0%A4%A")).toBe("%E0%A4%A");
	});

	it("keeps the current Project resource contract explicit", () => {
		expect(getProjectResourceDefinition("skills").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("vaults").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("sessions").projectScope).toBe("activity");
		expect(getProjectResourceDefinition("memories").projectScope).toBe("account-wide");
		expect(getProjectResourceDefinition("channels").projectScope).toBe("account-wide");
	});

	it("keeps navigation order grouped by resource ownership", () => {
		expect(PROJECT_RESOURCE_NAV_IDS).toEqual([
			"projects",
			"skills",
			"vaults",
			"sessions",
			"memories",
			"channels",
			"connectors",
		]);
		expect(projectResourceDefinitionsForGroup("project-resources").map((r) => r.id)).toEqual([
			"skills",
			"vaults",
		]);
		expect(projectManagedResourceDefinitions().map((r) => r.id)).toEqual(["skills", "vaults"]);
	});

	it("renders stable user-facing scope labels", () => {
		expect(projectResourceScopeLabel("container")).toBe("Project home");
		expect(projectResourceScopeLabel("project-managed")).toBe("Saved in a Project");
		expect(projectResourceScopeLabel("activity")).toBe("Account resources");
		expect(projectResourceScopeLabel("account-wide")).toBe("Account resources");
		expect(projectResourceScopeDescription(getProjectResourceDefinition("skills"))).toContain(
			"Pick the Project",
		);
	});

	it("renders resource paths from reusable path segments", () => {
		expect(projectResourcePathLabel(getProjectResourceDefinition("projects"))).toBe("Projects");
		expect(projectResourcePathLabel(getProjectResourceDefinition("skills"))).toBe(
			"Projects / Selected Project / Skills",
		);
		expect(projectResourcePathLabel(getProjectResourceDefinition("vaults"))).toBe(
			"Projects / Selected Project / Vaults",
		);
		expect(projectResourcePathLabel(getProjectResourceDefinition("sessions"))).toBe(
			"Account resources / Sessions",
		);
		expect(projectResourcePathLabel(getProjectResourceDefinition("memories"))).toBe(
			"Account resources / Memory",
		);
		expect(projectResourcePathLabel(getProjectResourceDefinition("channels"))).toBe(
			"Account resources / Channels",
		);
		expect(projectResourcePathLabel(getProjectResourceDefinition("connectors"))).toBe(
			"Account resources / Connectors",
		);
		expect(getProjectResourceDefinition("vaults").navLabel).toBe("Vaults");
	});
});
