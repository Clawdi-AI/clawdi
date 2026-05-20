import { findProjectFolderLink } from "./project-folders";
import type { ResolveReferenceOptions } from "./secret-references";

export interface ReferenceContextOptions extends ResolveReferenceOptions {
	projectFolder?: boolean;
}

export function applyLinkedProjectContext(opts: ReferenceContextOptions): ResolveReferenceOptions {
	if (opts.project || opts.projectId || opts.agent || opts.projectFolder === false) return opts;
	const match = findProjectFolderLink();
	if (!match) return opts;
	return { ...opts, projectId: match.link.project_id };
}
