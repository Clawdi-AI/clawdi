import { type Command, Option } from "commander";

export function registerProject(program: Command): void {
	const projectCmd = program
		.command("project")
		.description("Manage projects, people, invites, links, and shared access")
		.addHelpText(
			"after",
			`
Folder-link workflow:
  $ clawdi project folder link --project engineering
  $ clawdi project folder status
  $ clawdi run -- npm run deploy

Notes:
	  project list shows user-created and shared projects by default.
	  Use project list --include-workspaces to inspect agent workspaces.`,
		);

	projectCmd
		.command("create <name>")
		.description("Create a project")
		.option("--slug <slug>", "Optional stable slug (lowercase letters, numbers, hyphens)")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ clawdi project create "Engineering toolkit"\n' +
				'  $ clawdi project create "Client Alpha" --slug client-alpha --json',
		)
		.action(async (name: string, opts: { slug?: string; json?: boolean }) => {
			const { projectCreateCommand } = await import("../../commands/project-create.js");
			await projectCreateCommand(name, opts);
		});

	projectCmd
		.command("list")
		.description("List owned projects and projects shared with you")
		.option("--json", "Output as JSON")
		.option("--shared-with-me", "Show only projects shared with you")
		.option("--owned", "Show only projects you own")
		.option("--include-workspaces", "Include agent workspaces")
		.addOption(new Option("--include-envs").hideHelp())
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi project list\n  $ clawdi project list --include-workspaces\n  $ clawdi project list --shared-with-me --json",
		)
		.action(
			async (opts: {
				json?: boolean;
				sharedWithMe?: boolean;
				owned?: boolean;
				includeEnvs?: boolean;
				includeWorkspaces?: boolean;
			}) => {
				const { projectListCommand } = await import("../../commands/project-list.js");
				await projectListCommand({
					...opts,
					includeEnvs: opts.includeWorkspaces === true || opts.includeEnvs === true,
				});
			},
		);

	projectCmd
		.command("show <project>")
		.description("Show project content, role, owner, and next actions")
		.option("--json", "Output as JSON")
		.action(async (project: string, opts: { json?: boolean }) => {
			const { projectShowCommand } = await import("../../commands/project-show.js");
			await projectShowCommand(project, opts);
		});

	projectCmd
		.command("rm <project>")
		.description("Archive a project you created")
		.option("-y, --yes", "Confirm archiving without prompting")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi project rm engineering --yes --json")
		.action(async (project: string, opts: { yes?: boolean; json?: boolean }) => {
			const { projectRmCommand } = await import("../../commands/project-rm.js");
			await projectRmCommand(project, opts);
		});

	const projectFolderCmd = projectCmd
		.command("folder")
		.description("Link local folders to projects for automatic vault env selection");

	projectFolderCmd
		.command("link [path]")
		.description("Use this folder with a project")
		.requiredOption("-p, --project <id-or-slug>", "Project UUID, slug, or owner-qualified slug")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi project folder link --project engineering
  $ clawdi project folder link ~/work/client-a --project @alice/engineering`,
		)
		.action(async (path: string | undefined, opts: { project: string }) => {
			const { projectFolderLinkCommand } = await import("../../commands/project-folders.js");
			await projectFolderLinkCommand(path, opts);
		});

	projectFolderCmd
		.command("unlink [path]")
		.description("Stop using this folder with its linked project")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi project folder unlink
  $ clawdi project folder unlink ~/work/client-a`,
		)
		.action(async (path: string | undefined) => {
			const { projectFolderUnlinkCommand } = await import("../../commands/project-folders.js");
			await projectFolderUnlinkCommand(path);
		});

	projectFolderCmd
		.command("status [path]")
		.description("Show which project clawdi run will use for a folder")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi project folder status
  $ clawdi project folder status ~/work/client-a`,
		)
		.action(async (path: string | undefined) => {
			const { projectFolderStatusCommand } = await import("../../commands/project-folders.js");
			await projectFolderStatusCommand(path);
		});

	projectCmd
		.command("share [project]")
		.description("Create a viewer project share link")
		.option("-l, --label <text>", "Optional label shown in the share-links list")
		.option("--json", "Output as JSON")
		.action(async (project: string | undefined, opts: { label?: string; json?: boolean }) => {
			const { projectShareCommand } = await import("../../commands/project-share.js");
			await projectShareCommand(project, opts);
		});

	projectCmd
		.command("share-links <project>")
		.description("List or revoke viewer project links")
		.option("--revoke <id-or-prefix>", "Revoke a specific link")
		.option("-y, --yes", "Confirm revoking a project share link")
		.option("--json", "Output as JSON")
		.action(async (project: string, opts: { revoke?: string; yes?: boolean; json?: boolean }) => {
			const { projectShareLinksCommand } = await import("../../commands/project-share-links.js");
			await projectShareLinksCommand(project, opts);
		});

	projectCmd
		.command("invite <project>")
		.description("Invite a person to viewer project access")
		.requiredOption("-e, --email <addr>", "Email address to invite")
		.option("--json", "Output as JSON")
		.action(async (project: string, opts: { email: string; json?: boolean }) => {
			const { projectInviteCommand } = await import("../../commands/project-invite.js");
			await projectInviteCommand(project, opts);
		});

	projectCmd
		.command("invites <project>")
		.description("List or cancel pending project invites")
		.option("--cancel <id>", "Cancel one of the pending invitations on this project")
		.option("-y, --yes", "Confirm canceling a project invitation")
		.addHelpText(
			"after",
			"\n  Recipient side (listing / accepting / declining invitations addressed to you)\n" +
				"  lives under `clawdi inbox`.",
		)
		.option("--json", "Output as JSON")
		.action(async (project: string, opts: { cancel?: string; yes?: boolean; json?: boolean }) => {
			const { projectInvitesCommand } = await import("../../commands/project-invites.js");
			await projectInvitesCommand(project, opts);
		});

	projectCmd
		.command("members <project>")
		.description("List or remove people with project access")
		.option("--remove <email-or-user-id>", "Remove one accepted member")
		.option("-y, --yes", "Confirm member removal without prompting")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi project members engineering --remove bob@example.com --yes\n\nNon-interactive removal without --yes is deprecated; --yes will be required starting in 0.16.",
		)
		.action(async (project: string, opts: { remove?: string; json?: boolean; yes?: boolean }) => {
			const { projectMembersCommand } = await import("../../commands/project-members.js");
			await projectMembersCommand(project, opts);
		});

	projectCmd
		.command("leave <project>")
		.description("Leave a project shared with you")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi project leave @alice-cdbf/engineering")
		.action(async (project: string, opts: { json?: boolean }) => {
			const { projectLeaveCommand } = await import("../../commands/project-members.js");
			await projectLeaveCommand(project, opts);
		});

	projectCmd
		.command("unshare <project>")
		.description("Owner: revoke links, cancel invites, and remove accepted viewers")
		.option("-y, --yes", "Confirm revoking all project sharing without prompting")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi project unshare engineering --yes\n\nNon-interactive sharing revocation without --yes is deprecated; --yes will be required starting in 0.16.",
		)
		.action(async (project: string, opts: { json?: boolean; yes?: boolean }) => {
			const { projectUnshareCommand } = await import("../../commands/project-members.js");
			await projectUnshareCommand(project, opts);
		});
}
