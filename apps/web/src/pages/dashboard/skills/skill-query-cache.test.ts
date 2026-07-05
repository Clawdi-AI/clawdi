import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
	removeDeletedSkillQueries,
	skillDetailQueryKey,
	skillDetailQueryPrefix,
} from "@/pages/dashboard/skills/skill-query-cache";

describe("removeDeletedSkillQueries", () => {
	test("removes deleted skill detail queries by prefix and invalidates skill lists", async () => {
		const qc = new QueryClient();
		const skillKey = "review/code";

		qc.setQueryData(skillDetailQueryKey(skillKey, "project_a"), { key: skillKey });
		qc.setQueryData(skillDetailQueryKey(skillKey, "project_b"), { key: skillKey });
		qc.setQueryData(skillDetailQueryKey("other/skill", "project_a"), { key: "other/skill" });
		qc.setQueryData(["skills"], [{ key: skillKey }]);
		qc.setQueryData(["skills", "all-projects"], [{ key: skillKey }]);

		await removeDeletedSkillQueries(qc, skillKey);

		expect(qc.getQueryData(skillDetailQueryKey(skillKey, "project_a"))).toBeUndefined();
		expect(qc.getQueryData(skillDetailQueryKey(skillKey, "project_b"))).toBeUndefined();
		expect(qc.getQueryData(skillDetailQueryPrefix(skillKey))).toBeUndefined();
		expect(
			qc.getQueryData<{ key: string }>(skillDetailQueryKey("other/skill", "project_a")),
		).toEqual({
			key: "other/skill",
		});
		expect(qc.getQueryState(["skills"])?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["skills", "all-projects"])?.isInvalidated).toBe(true);
	});
});
