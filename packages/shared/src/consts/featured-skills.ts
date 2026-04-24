export interface FeaturedSkill {
	repo: string;
	path?: string;
	name: string;
	description: string;
	/**
	 * The `skill_key` the backend will assign after install. The backend
	 * derives this from the `name:` field in the remote SKILL.md frontmatter
	 * (lowercased, spaces → hyphens). We hardcode the expected value here so
	 * the "Installed" marker on the marketplace grid is reliable without
	 * having to probe the SKILL.md.
	 */
	skillKey: string;
}

export const FEATURED_SKILLS: FeaturedSkill[] = [
	{
		repo: "anthropics/skills",
		path: "frontend-design",
		name: "Frontend Design",
		description:
			"Create distinctive, production-grade frontend interfaces that reject generic AI aesthetics",
		skillKey: "frontend-design",
	},
	{
		repo: "anthropics/skills",
		path: "webapp-testing",
		name: "Webapp Testing",
		description: "Test web applications using Playwright with screenshots and browser logs",
		skillKey: "webapp-testing",
	},
	{
		repo: "anthropics/skills",
		path: "claude-api",
		name: "Claude API",
		description: "Build, debug, and optimize Claude API and Anthropic SDK applications",
		skillKey: "claude-api",
	},
	{
		repo: "anthropics/skills",
		path: "mcp-builder",
		name: "MCP Builder",
		description: "Build Model Context Protocol servers and integrations",
		skillKey: "mcp-builder",
	},
	{
		repo: "anthropics/skills",
		path: "pdf",
		name: "PDF",
		description: "Read and process PDF documents for analysis and extraction",
		skillKey: "pdf",
	},
	{
		repo: "anthropics/skills",
		path: "docx",
		name: "DOCX",
		description: "Create and edit Word documents programmatically",
		skillKey: "docx",
	},
	{
		repo: "anthropics/skills",
		path: "canvas-design",
		name: "Canvas Design",
		description: "Create visual designs and graphics using HTML5 Canvas",
		skillKey: "canvas-design",
	},
	{
		repo: "anthropics/skills",
		path: "skill-creator",
		name: "Skill Creator",
		description: "Create new agent skills following the SKILL.md standard",
		skillKey: "skill-creator",
	},
];
