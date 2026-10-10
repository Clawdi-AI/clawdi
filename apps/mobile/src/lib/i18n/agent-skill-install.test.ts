import { expect, test } from "bun:test";
import { agentSkillGuardPresentation } from "@clawdi/shared/view";
import { en } from "./en";

test.each([
	{
		source: "project",
		observation_error_code: "guard_blocked",
		expected: "Install it from its GitHub source",
	},
	{ source: "github", observation_error_code: "guard_blocked", expected: "Choose another skill." },
	{
		source: "project",
		observation_error_code: "guard_confirmation_required",
		expected: "needs explicit confirmation for this skill. Retrying won't help.",
	},
] as const)(
	"mobile i18n resolves the selected guard guidance for %j",
	({ source, observation_error_code, expected }) => {
		const presentation = agentSkillGuardPresentation({
			source,
			convergence: "failed",
			observation_error_code,
		});
		if (!presentation) throw new Error("Missing guard presentation");
		expect(en.agentExtensions[presentation.title]).toContain("Hermes Skills Guard");
		expect(en.agentExtensions[presentation.message]).toContain(expected);
		if (source === "github") {
			expect(en.agentExtensions[presentation.message]).not.toContain(
				"Install it from its GitHub source",
			);
		}
	},
);
