export const workspaceSkillsEn = {
	title: "Workspace GitHub Skills",
	description:
		"Manage GitHub Skills requested for this hosted Agent. Library references and runtime plugins are not managed on this screen.",
	source: "GitHub owner/repo or owner/repo/path",
	install: "Request installation",
	uninstall: "Request removal",
	confirm: "Change Workspace Skills?",
	warning:
		"This updates the Agent's desired Skill manifest. Runtime application may complete later. Existing Cloud library Skills are not modified.",
	unavailable:
		"New changes are unavailable until the Agent's capability and current version are confirmed.",
	managed: "Managed",
	requested: "Requested — refresh to check runtime status",
	failed: "Runtime application failed — refresh to review status",
	accepted:
		"Desired state accepted. Refresh to inspect runtime status; this is not proof the runtime has finished applying it.",
	open: "Read Skill",
	empty: "No GitHub Skills in the desired manifest.",
	uncertain:
		"An unresolved request is saved. Retry its exact body, resource version and key; refreshing does not prove whether it was accepted.",
	retry: "Retry saved request",
	discard: "Discard unsubmitted or rejected request",
	discardWarning:
		"Discard this local request and reload the current manifest? No uncertain request can be discarded here.",
	storageError:
		"Saved request could not be read or changed. Reload recovery before starting another change.",
	reload: "Reload recovery",
	error:
		"The action was not confirmed. Review current state and the saved request before continuing.",
};
