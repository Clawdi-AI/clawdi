import type { ProjectMetadata } from "./project-metadata";
export function projectDetailDescription(project: ProjectMetadata, isOwner: boolean) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? "Add Skills and Vaults here, then choose which Agents use this Project."
			: "Project shared with you. Linked Agents use its Skills and Vaults together.";
	}
	if (project.kind === "environment") {
		return `Workspace ${access}. This private Workspace belongs to one Agent and cannot be shared.`;
	}
	if (project.kind === "personal") {
		return `Private resources ${access}.`;
	}
	return `Project ${access}.`;
}

export const LIBRARY_COPY = {
	pending: "Pending",
	done: "Done",
	select: "Select",
	transferKeys: "Copy or move keys",
	manageAgents: "Manage agents",
	chooseAgents: "Choose which Agents can use this Project.",
	noAgentsAvailable: "No Agents available",
	addAgentFirst:
		"Add an Agent from Overview first, then link this Project here or from the Agent's Projects section.",
	loadAgentsFailed: "Couldn't load Agents",
	updateAgentsFailed: "Couldn't update Agent access",
	projectBundleDescription:
		"Keep reusable Skills and Vault access together, then link the whole Project to any Agent that needs it.",
	projectSkillsDescription: "Reusable instructions that belong to this Project.",
	emptyProjectSkills: "No skills are visible in this Project yet.",
	addSkill: "Add skill",
	projectVaultsDescription: "Vaults included in this Project.",
	manageVaults: "Manage vaults",
	people: "People",
	peopleDescription:
		"Members see Skills and key names. Key values stay protected, and their linked Agents can use them.",
	yourAgents: "Your Agents",
	projectAgentsDescription: "Agents you own that use this Project's Skills and Vaults.",
	emptyProjectAgents:
		"None of your Agents are linked yet. Link this Project to let one use its Skills and Vaults.",
	createProject: "Create project",
	editProject: "Edit project",
	projectBundle: "Project bundle",
	chooseProject: "Choose a Project",
	createSkill: "Create skill",
	importSkill: "Import from GitHub",
	createMemory: "Create memory",
	searchProjects: "Search projects…",
	searchSkills: "Search skills…",
	searchMemories: "Search memories…",
	searchVaults: "Search vaults…",
	searchConnectors: "Search connectors…",
	searchKeys: "Search keys…",
	createVault: "Create vault",
	addKeys: "Add keys",
	shared: "Shared with you",
	sharedVaults: "Read-only — your agents can use these keys; only the owner can edit them.",
	noProjects: "No Projects yet",
	noProjectMatches: "No matching Projects",
	emptyProjects: "Create a Project to bundle Skills and Vaults for your Agents.",
	noMemories:
		"No memories yet. Create one above, or your Agents will create them automatically as they work.",
	noMemoryMatches: "No matches — try a different search or category.",
	noVaults: "No vaults yet",
	emptyVaults: "Create a vault to group API keys for your agents.",
	yourConnections: "Your connections",
	allConnectors: "All Connectors",
	noConnectors: "No connectors available",
	connect: "Connect",
	connectAccount: "Connect account",
	accounts: "Accounts",
	tools: "Available tools",
	accountsDescription:
		"Connect an account once. Approved tools become available to agents through this connector.",
	toolsDescription: "Review the actions agents can request through this connector.",
	recallScope: "Recall Scope",
	recallDescription:
		"This is account-level context. Agents can recall it across runs; it is not shared through Projects.",
	vaultDescription: "Keys live here once and work in every Project this Vault is linked to.",
	sharedVaultDescription:
		"Shared with you — your agents can use these keys; only the owner edits them.",
	keysDescription: "Values are write-only here. Changes apply everywhere this Vault is linked.",
	vaultProjectsDescription:
		"Same Vault everywhere — key changes apply to every linked Project. Key values stay protected, and linked Projects and Agents can use them.",
	projectSkillDescription:
		"This Skill belongs to this Project. Linked Agents use it automatically.",
	instructionDescription:
		"This instruction file belongs to the Project. Linked Agents use updates automatically.",
	instructionFile: "Instruction file",
	delete: "Delete",
	edit: "Edit",
	cancel: "Cancel",
	save: "Save changes",
	name: "Name",
	description: "Description",
	content: "Content",
	category: "Category",
	projectFormDescription: "Group Skills and Vaults in a Project.",
} as const;
export const PROJECT_LOCAL_TABS = [
	{ id: "overview", label: "Overview" },
	{ id: "skills", label: "Skills" },
	{ id: "vaults", label: "Vaults" },
	{ id: "agents", label: "Agents" },
	{ id: "access", label: "Access" },
] as const;

export const SHARING_COPY = {
	permissions:
		"People can view this Project and let their Agents use its keys. Secret values stay hidden in the dashboard. Only you can edit.",
	people: "People with access",
	onlyYou: "Only you have access",
	inviteLink: "Invite link",
	createLink: "Create invite link",
	linkDescription: "Anyone with the link can preview and join this Project.",
	manage: "Manage sharing",
	stop: "Stop all sharing",
	email: "Enter email address",
	invite: "Invite",
} as const;

export const VAULT_REQUEST_COPY = {
	unavailable: "This request has changed or its link has expired. Ask your agent for a new link.",
	saved: "Saved securely",
	unavailableTitle: "Link unavailable",
	title: "Save to Vault",
	privacy: "Only these fields will be saved. Anyone with Vault access can use them.",
	done: "Your secrets are saved. Send this message to your agent to continue.",
	multiline: "Multiline value hidden",
} as const;
export function buildVaultSupplyAgentMessage(requestId: string) {
	return `I've saved the requested credentials. Please check Vault request ${requestId}; once its status is supplied, continue our previous task using existing authorized capabilities. Do not include secret values in chat.`;
}
