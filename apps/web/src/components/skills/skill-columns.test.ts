import { describe, expect, it } from "bun:test";
import { resolveSkillProjectAccess } from "./skill-columns";

describe("resolveSkillProjectAccess", () => {
	it("allows the selected project before the ownership map loads", () => {
		expect(
			resolveSkillProjectAccess(
				{ project_id: "project-current" },
				{ currentProjectId: "project-current" },
			),
		).toBe("writable");
	});

	it("keeps non-selected projects unknown until ownership is loaded", () => {
		expect(
			resolveSkillProjectAccess(
				{ project_id: "project-orphan" },
				{ currentProjectId: "project-current" },
			),
		).toBe("unknown");
	});

	it("keeps owned orphan project skills writable", () => {
		expect(
			resolveSkillProjectAccess(
				{ project_id: "project-orphan" },
				{
					currentProjectId: "project-current",
					writableProjectIds: new Set(["project-current", "project-orphan"]),
				},
			),
		).toBe("writable");
	});

	it("marks shared project skills read-only", () => {
		expect(
			resolveSkillProjectAccess(
				{ project_id: "project-shared" },
				{ writableProjectIds: new Set(["project-current"]) },
			),
		).toBe("read-only");
	});
});
