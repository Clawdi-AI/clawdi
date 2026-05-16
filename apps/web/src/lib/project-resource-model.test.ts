import { describe, expect, it } from "bun:test";
import {
	getProjectResourceDefinition,
	projectResourceHref,
	projectResourceScopeLabel,
} from "./project-resource-model";

describe("project resource model", () => {
	it("builds Project-scoped links only for managed resources", () => {
		expect(projectResourceHref("skills", "proj_1")).toBe("/skills?project=proj_1");
		expect(projectResourceHref("vaults", "proj 1")).toBe("/vault?project=proj%201");
		expect(projectResourceHref("memories", "proj_1")).toBe("/memories");
		expect(projectResourceHref("sessions", "proj_1")).toBe("/sessions");
	});

	it("keeps the current Project resource contract explicit", () => {
		expect(getProjectResourceDefinition("skills").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("vaults").projectScope).toBe("project-managed");
		expect(getProjectResourceDefinition("sessions").projectScope).toBe("activity");
		expect(getProjectResourceDefinition("memories").projectScope).toBe("account-wide");
	});

	it("renders stable user-facing scope labels", () => {
		expect(projectResourceScopeLabel("project-managed")).toBe("Project-managed");
		expect(projectResourceScopeLabel("activity")).toBe("Activity history");
		expect(projectResourceScopeLabel("account-wide")).toBe("Account-wide");
	});
});
