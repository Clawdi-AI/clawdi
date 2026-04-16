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
		description: "Create distinctive, production-grade frontend interfaces that reject generic AI aesthetics",
		installs: "300K",
	},
	{
		repo: "vercel-labs/agent-skills",
		path: "vercel-react-best-practices",
		name: "React Best Practices",
		description: "React and Next.js performance optimization guidelines from Vercel Engineering",
		installs: "320K",
	},
	{
		repo: "anthropics/skills",
		path: "commit",
		name: "Git Commit",
		description: "Create well-structured git commits following conventional commit standards",
		installs: "250K",
	},
	{
		repo: "anthropics/skills",
		path: "review",
		name: "Code Review",
		description: "Review pull requests with structured feedback and actionable suggestions",
		installs: "200K",
	},
	{
		repo: "anthropics/skills",
		path: "security-review",
		name: "Security Review",
		description: "Complete security review of pending changes on the current branch",
		installs: "150K",
	},
	{
		repo: "vercel-labs/skills",
		path: "find-skills",
		name: "Find Skills",
		description: "Search and discover agent skills from the skills.sh marketplace",
		installs: "1.1M",
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
		path: "init",
		name: "Init CLAUDE.md",
		description: "Initialize a new CLAUDE.md file with codebase documentation",
		installs: "120K",
	},
];
