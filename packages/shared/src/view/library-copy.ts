import type { ProjectMetadata } from "./project-metadata";
import { displayProjectName } from "./project-metadata";

export function skillsPageDescription(project?: ProjectMetadata) {
	return project
		? `Skills in ${displayProjectName(project)}. Linked agents use the whole project.`
		: "Choose a project to view or add its skills.";
}
export function projectDetailDescription(project: ProjectMetadata, isOwner: boolean) {
	const access = isOwner ? "you own" : "shared with you";
	if (project.kind === "workspace") {
		return isOwner
			? "Add skills and vaults here, then choose which agents use this project."
			: "Project shared with you. Linked agents use its skills and vaults together.";
	}
	if (project.kind === "environment") {
		return `Workspace ${access}. This private workspace belongs to one agent and cannot be shared.`;
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
	copyOrMove: "Copy or move",
	removeFromProject: "Remove from project",
	agentVaultsDescription:
		"Vaults available through this agent's workspace and linked projects. Configure vaults in the source project.",
	agentVaultsError: "Couldn't load agent vault access",
	manageAgents: "Manage agents",
	chooseAgents: "Choose which agents can use this project.",
	noAgentsAvailable: "No agents available",
	addAgentFirst:
		"Add an agent from Overview first, then link this project here or from the agent's Projects section.",
	loadAgentsFailed: "Couldn't load agents",
	updateAgentsFailed: "Couldn't update agent access",
	projectBundleDescription:
		"Keep reusable skills and vault access together, then link the whole project to any agent that needs it.",
	projectSkillsDescription: "Reusable instructions that belong to this project.",
	emptyProjectSkills: "No skills are visible in this project yet.",
	addSkill: "Add skill",
	projectVaultsDescription: "Vaults included in this project.",
	manageVaults: "Manage vaults",
	people: "People",
	peopleDescription:
		"Members see skills and key names. Key values stay protected, and their linked agents can use them.",
	yourAgents: "Your agents",
	projectAgentsDescription: "Agents you own that use this project's skills and vaults.",
	emptyProjectAgents:
		"None of your agents are linked yet. Link this project to let one use its skills and vaults.",
	createProject: "Create project",
	editProject: "Edit project",
	projectBundle: "Project bundle",
	chooseProject: "Choose a project",
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
	noProjects: "No projects yet",
	noProjectMatches: "No matching projects",
	emptyProjects: "Create a project to bundle skills and vaults for your agents.",
	noMemories: "No memories yet",
	emptyMemories: "Create one, or your agents will create them automatically as they work.",
	noMemoryMatches: "No matches — try a different search or category.",
	noVaults: "No vaults yet",
	emptyVaults: "Create a vault to group API keys for your agents.",
	yourConnections: "Your connections",
	allConnectors: "All connectors",
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
		"This is account-level context. Agents can recall it across runs; it is not shared through projects.",
	vaultDescription: "Keys live here once and work in every project this vault is linked to.",
	sharedVaultDescription:
		"Shared with you — your agents can use these keys; only the owner edits them.",
	keysDescription: "Values are write-only here. Changes apply everywhere this vault is linked.",
	vaultProjectsDescription:
		"Key changes apply to every linked project. Values stay protected; linked projects and agents can use them.",
	projectSkillDescription:
		"This skill belongs to this project. Linked agents use it automatically.",
	instructionDescription:
		"This instruction file belongs to the project. Linked agents use updates automatically.",
	instructionFile: "Instruction file",
	delete: "Delete",
	edit: "Edit",
	cancel: "Cancel",
	save: "Save changes",
	name: "Name",
	description: "Description",
	content: "Content",
	category: "Category",
	projectFormDescription: "Group skills and vaults in a project.",
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
		"People can view this project and let their agents use its keys. Only you can edit, and secret values stay hidden in the dashboard.",
	people: "People with access",
	onlyYou: "Only you have access",
	inviteLink: "Invite link",
	createLink: "Create invite link",
	linkDescription: "Anyone with the link can preview and join this project.",
	manage: "Manage sharing",
	stop: "Stop all sharing",
	email: "Enter email address",
	invite: "Invite",
} as const;

export const VAULT_REQUEST_COPY = {
	unavailable: "This request has changed or its link has expired. Ask your agent for a new link.",
	saved: "Saved securely",
	unavailableTitle: "Link unavailable",
	title: "Save to vault",
	privacy: "Only these fields will be saved. Anyone with vault access can use them.",
	done: "Your secrets are saved. Send this message to your agent to continue.",
	multiline: "Multiline value hidden",
} as const;
export function buildVaultSupplyAgentMessage(requestId: string) {
	return `I've saved the requested credentials. Please check Vault request ${requestId}; once its status is supplied, continue our previous task using existing authorized capabilities. Do not include secret values in chat.`;
}
