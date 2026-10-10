import { expect, test } from "bun:test";
import { agentSkillGuardPresentation, agentSkillInstallCopy } from "@clawdi/shared/view";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillCard } from "./skill-card";

test("renders the complete guard refusal guidance on a skill card", () => {
	const html = renderToStaticMarkup(
		<SkillCard
			skill={{ skill_key: "skill-creator", name: "skill-creator", description: null }}
			readOnly
			installationMessage={agentSkillInstallCopy.guardBlocked}
		/>,
	);
	expect(html).toContain('role="status"');
	expect(html).toContain("Skills Guard blocked this skill (it flagged risky code).");
	expect(html).toContain(
		"Install it from its GitHub source to review it, or choose another skill.",
	);
});

test.each([
	{ source: "github", observation_error_code: "guard_blocked", expected: "Choose another skill." },
	{
		source: "project",
		observation_error_code: "guard_confirmation_required",
		expected: "needs explicit confirmation for this skill.",
	},
] as const)(
	"renders distinct guard guidance for %j",
	({ source, observation_error_code, expected }) => {
		const presentation = agentSkillGuardPresentation({
			source,
			convergence: "failed",
			observation_error_code,
		});
		if (!presentation) throw new Error("Missing guard presentation");
		const html = renderToStaticMarkup(
			<SkillCard
				skill={{ skill_key: "review", name: "Review", description: null }}
				readOnly
				installationMessage={agentSkillInstallCopy[presentation.message]}
			/>,
		);
		expect(html).toContain(expected);
		expect(html).not.toContain("Install it from its GitHub source");
		expect(html).not.toContain("retry automatically");
	},
);
