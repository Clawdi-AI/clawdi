import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativeUrl: string): string {
	return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("Skill authority across Web mutation surfaces", () => {
	test("cards suppress send, selection, and uninstall while preserving detail navigation", () => {
		const card = source("./skill-card.tsx");
		expect(card).toContain("const canSend = !readOnly");
		expect(card).toContain("const canUninstall = !readOnly");
		expect(card).toContain("selectMode && selectable");
		expect(card).toContain("link={selectMode ? undefined : detailLink}");
		expect(card).not.toContain("cleanupOnly");
	});

	test("global cards, groups, bulk actions, and duplicate sync use one capability projection", () => {
		const page = source("../../pages/dashboard/skills/page.tsx");
		expect(page).toContain("capabilitiesFor={capabilitiesForSkill}");
		expect(page).toContain("capabilitiesForSkill(skill).canSelect");
		expect(page).toContain("capabilitiesForSkill(copy).canSync");
		expect(page).toContain("capabilitiesForSkill(s).canDelete");
		expect(page).toContain("isBrowserWritableSkillProject(targetProject)");
	});

	test("Send exposes only owned workspace/personal destinations and rechecks its sources", () => {
		const dialog = source("./send-skill-dialog.tsx");
		expect(dialog).toContain('p.kind === "workspace" || p.kind === "personal"');
		expect(dialog).toContain(").canSend");
		expect(dialog).not.toMatch(/agentTargets|default_project_id|SelectLabel>Agents/);
	});

	test("detail and Project pages guard environment and agent-sync mutations", () => {
		const detail = source("../../pages/dashboard/skills/[key]/page.tsx");
		const project = source("../../pages/dashboard/projects/[id]/page.tsx");
		expect(detail).toContain("skillCapabilities(skill");
		expect(detail).toContain("if (!capabilities?.canUpdate)");
		expect(detail).toContain("if (!capabilities?.canDelete)");
		expect(project).toContain("isBrowserWritableSkillProject(project)");
		expect(project).toContain("capabilitiesFor={(skill) => skillCapabilities(skill, project)}");
	});
});
