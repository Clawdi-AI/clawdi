import { describe, expect, it } from "bun:test";
import {
	connectorDetailHref,
	getProjectResourceDefinition,
	memoryDetailHref,
	PROJECT_RESOURCE_NAV_IDS,
	projectDetailHref,
	projectManagedResourceDefinitions,
	projectResourceDefinitionsForGroup,
	projectResourceHref,
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
	});

	it("builds stable detail links for resource rows", () => {
		expect(projectDetailHref("proj 1")).toBe("/projects/proj%201");
		expect(skillDetailHref("team/foo", "proj 1")).toBe("/skills/team%2Ffoo?project=proj%201");
		expect(skillDetailHref("team/foo")).toBe("/skills/team%2Ffoo");
		expect(sessionDetailHref("session 1")).toBe("/sessions/session%201");
		expect(memoryDetailHref("memory 1")).toBe("/memories/memory%201");
		expect(connectorDetailHref("google drive")).toBe("/connectors/google%20drive");
	});

	it("keeps the current Project resource contract explicit", () => {
		expect(getProjectResourceDefinition("skills").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("vaults").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("sessions").projectScope).toBe("activity");
		expect(getProjectResourceDefinition("memories").projectScope).toBe("account-wide");
	});

	it("keeps navigation order grouped by resource ownership", () => {
		expect(PROJECT_RESOURCE_NAV_IDS).toEqual([
			"projects",
			"skills",
			"vaults",
			"sessions",
			"memories",
			"connectors",
		]);
		expect(projectResourceDefinitionsForGroup("project-resources").map((r) => r.id)).toEqual([
			"skills",
			"vaults",
		]);
		expect(projectManagedResourceDefinitions().map((r) => r.id)).toEqual(["skills", "vaults"]);
	});

	it("renders stable user-facing scope labels", () => {
		expect(projectResourceScopeLabel("container")).toBe("Project registry");
		expect(projectResourceScopeLabel("project-managed")).toBe("Project-managed");
		expect(projectResourceScopeLabel("activity")).toBe("Activity history");
		expect(projectResourceScopeLabel("account-wide")).toBe("Account-wide");
		expect(projectResourceScopeDescription(getProjectResourceDefinition("skills"))).toContain(
			"?project=",
		);
	});
});
