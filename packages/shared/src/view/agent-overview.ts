/** Text shared by the Web and native Agent overview. */
export const agentOverviewCopy = {
	description: "Status, resources, and recent activity for this agent.",
	recentSessions: "Recent sessions",
	viewAll: "View all",
	noRecentSessions: "No recent sessions",
	status: "Status",
	machine: "Machine",
	lastSeen: "Last seen",
	workspace: "Workspace",
	shared: "Shared",
	unavailable: "Unavailable right now",
};
export function agentOverviewSummary(
	resource: "projects" | "skills" | "vaults" | "memories" | "connectors",
	total: number,
) {
	switch (resource) {
		case "projects":
			return total
				? `${total} linked ${total === 1 ? "project" : "projects"}`
				: "No projects linked";
		case "skills":
			return total ? `${total} ${total === 1 ? "skill" : "skills"}` : "No skills installed";
		case "vaults":
			return total ? `${total} ${total === 1 ? "vault" : "vaults"}` : "No vaults available";
		case "memories":
			return total
				? `${total} ${total === 1 ? "memory" : "memories"} · all agents`
				: "No memories yet · all agents";
		case "connectors":
			return total ? `${total} ${total === 1 ? "app" : "apps"} · all agents` : "No apps available";
	}
}
