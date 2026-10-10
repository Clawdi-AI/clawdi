import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillUpdateFailureAlert } from "./skill-update-failure-alert";

test.each(["guard_blocked", "guard_confirmation_required"] as const)(
	"panel omits the automatic retry alert for %s, including duplicate workspace status",
	(observation_error_code) => {
		const guard = {
			skill_key: "review",
			source: "github" as const,
			convergence: "failed" as const,
			observation_error_code,
		};
		expect(
			renderToStaticMarkup(
				<SkillUpdateFailureAlert
					managed={[guard]}
					hosted={[{ skill_key: "review", status: "failed" }]}
				/>,
			),
		).toBe("");
		const ordinary = {
			...guard,
			skill_key: "other",
			observation_error_code: "reconcile_failed" as const,
		};
		expect(
			renderToStaticMarkup(<SkillUpdateFailureAlert managed={[guard, ordinary]} hosted={[]} />),
		).toContain("retry automatically");
		expect(
			renderToStaticMarkup(
				<SkillUpdateFailureAlert
					managed={[guard]}
					hosted={[{ skill_key: "other", status: "failed" }]}
				/>,
			),
		).toContain("retry automatically");
	},
);
