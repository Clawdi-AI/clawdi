import { expect, test } from "bun:test";
import { agentSkillInstallCopy } from "@clawdi/shared/view";
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
