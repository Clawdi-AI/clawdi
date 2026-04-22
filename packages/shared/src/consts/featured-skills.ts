export interface FeaturedSkill {
	repo: string;
	path?: string;
	name: string;
	description: string;
	installs: string;
}

export const FEATURED_SKILLS: FeaturedSkill[] = [
	{
		repo: "anthropics/skills",
		path: "frontend-design",
		name: "Frontend Design",
		description:
			"Create distinctive, production-grade frontend interfaces that reject generic AI aesthetics",
		installs: "300K",
	},
	{
		repo: "anthropics/skills",
		path: "webapp-testing",
		name: "Webapp Testing",
		description: "Test web applications using Playwright with screenshots and browser logs",
		installs: "180K",
	},
	{
		repo: "anthropics/skills",
		path: "claude-api",
		name: "Claude API",
		description: "Build, debug, and optimize Claude API and Anthropic SDK applications",
		installs: "150K",
	},
	{
		repo: "anthropics/skills",
		path: "mcp-builder",
		name: "MCP Builder",
		description: "Build Model Context Protocol servers and integrations",
		installs: "120K",
	},
	{
		repo: "anthropics/skills",
		path: "pdf",
		name: "PDF",
		description: "Read and process PDF documents for analysis and extraction",
		installs: "100K",
	},
	{
		repo: "anthropics/skills",
		path: "docx",
		name: "DOCX",
		description: "Create and edit Word documents programmatically",
		installs: "90K",
	},
	{
		repo: "anthropics/skills",
		path: "canvas-design",
		name: "Canvas Design",
		description: "Create visual designs and graphics using HTML5 Canvas",
		installs: "80K",
	},
	{
		repo: "anthropics/skills",
		path: "skill-creator",
		name: "Skill Creator",
		description: "Create new agent skills following the SKILL.md standard",
		installs: "70K",
	},
];
