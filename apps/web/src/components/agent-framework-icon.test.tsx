import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { FRAMEWORK_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";

const FRAMEWORKS = {
	openclaw: "OpenClaw",
	hermes: "Hermes Agent",
	"claude-code": "Claude Code",
	codex: "Codex",
} as const;

describe("AgentFrameworkIcon", () => {
	test("renders all supported framework IDs as accessible official LobeHub SVG components", () => {
		expect(Object.keys(FRAMEWORKS)).toEqual([...FRAMEWORK_BRAND_ICON_IDS]);
		for (const id of FRAMEWORK_BRAND_ICON_IDS) {
			const label = FRAMEWORKS[id];
			expect(frameworkBrandIcon(id)?.label).toBe(label);
			const markup = renderToStaticMarkup(
				<AgentFrameworkIcon agent={id} pixelSize={40} boxClassName="size-10" />,
			);
			expect(markup).toContain("<svg");
			expect(markup).toContain('role="img"');
			expect(markup).toContain(`aria-label="${label}"`);
			expect(markup).toContain(`<title>${label}</title>`);
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain('width="84%"');
			expect(markup).toContain('height="84%"');
			expect(markup).toContain("width:84%;height:84%");
			expect(markup).not.toContain("<img");
		}
	});

	test("preserves the claude_code wire alias", () => {
		expect(frameworkBrandIcon("claude_code")?.icon).toBe(frameworkBrandIcon("claude-code")?.icon);
	});

	test("keeps the official Hermes black mark on white instead of theme-inverting it", () => {
		const markup = renderToStaticMarkup(
			<AgentFrameworkIcon agent="hermes" pixelSize={40} boxClassName="size-10" />,
		);
		expect(markup).toContain("bg-white");
		expect(markup).toContain("text-black");
	});

	test("keeps custom avatars as object-cover images instead of scaling them like brand marks", () => {
		const markup = renderToStaticMarkup(
			<AgentFrameworkIcon
				agent="codex"
				pixelSize={32}
				boxClassName="size-8 rounded-md"
				avatarUrl="https://example.test/avatar.png"
				alt="Custom avatar"
			/>,
		);
		expect(markup).toContain('<img src="https://example.test/avatar.png"');
		expect(markup).toContain('alt="Custom avatar"');
		expect(markup).toContain('width="32"');
		expect(markup).toContain('height="32"');
		expect(markup).toContain("object-cover");
		expect(markup).not.toContain("<svg");
		expect(markup).not.toContain('data-icon-source="lobehub"');
	});
});
