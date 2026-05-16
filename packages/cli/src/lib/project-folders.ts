import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { getClawdiDir } from "./config";

export interface ProjectFolderLink {
	path: string;
	project_id: string;
	project_label: string;
	project_name?: string;
	project_slug?: string;
	owner_handle?: string | null;
	owner_display?: string | null;
	linked_at: string;
}

export interface ProjectFoldersConfig {
	version: 1;
	links: ProjectFolderLink[];
}

export interface ProjectFolderMatch {
	link: ProjectFolderLink;
	source: "exact" | "parent";
}

const EMPTY_CONFIG: ProjectFoldersConfig = { version: 1, links: [] };

export function projectFoldersFile(): string {
	return resolve(getClawdiDir(), "project-folders.json");
}

export function normalizeFolderPath(input: string | undefined = process.cwd()): string {
	const expanded = expandHome(input.trim() || process.cwd());
	const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
	const normalized = trimTrailingSeparators(normalize(absolute));
	try {
		return trimTrailingSeparators(realpathSync.native(normalized));
	} catch {
		return normalized;
	}
}

export function readProjectFoldersConfig(): ProjectFoldersConfig {
	const file = projectFoldersFile();
	if (!existsSync(file)) return { ...EMPTY_CONFIG, links: [] };
	const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<ProjectFoldersConfig>;
	const links = Array.isArray(parsed.links)
		? parsed.links
				.filter(isProjectFolderLink)
				.map((link) => ({ ...link, path: normalizeFolderPath(link.path) }))
		: [];
	return { version: 1, links };
}

export function writeProjectFoldersConfig(config: ProjectFoldersConfig): void {
	const file = projectFoldersFile();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ version: 1, links: config.links }, null, 2)}\n`, {
		mode: 0o600,
	});
	try {
		chmodSync(file, 0o600);
	} catch {
		/* best effort on Windows / read-only filesystems */
	}
}

export function listProjectFolderLinks(): ProjectFolderLink[] {
	return readProjectFoldersConfig().links;
}

export function setProjectFolderLink(
	folderPath: string | undefined,
	project: Omit<ProjectFolderLink, "path" | "linked_at">,
): ProjectFolderLink {
	const path = normalizeFolderPath(folderPath);
	const config = readProjectFoldersConfig();
	const next: ProjectFolderLink = {
		path,
		project_id: project.project_id,
		project_label: project.project_label,
		project_name: project.project_name,
		project_slug: project.project_slug,
		owner_handle: project.owner_handle ?? null,
		owner_display: project.owner_display ?? null,
		linked_at: new Date().toISOString(),
	};
	config.links = [
		...config.links.filter((link) => comparablePath(link.path) !== comparablePath(path)),
		next,
	].sort((a, b) => a.path.localeCompare(b.path));
	writeProjectFoldersConfig(config);
	return next;
}

export function removeProjectFolderLink(folderPath: string | undefined): ProjectFolderLink | null {
	const path = normalizeFolderPath(folderPath);
	const config = readProjectFoldersConfig();
	const match =
		config.links.find((link) => comparablePath(link.path) === comparablePath(path)) ?? null;
	if (!match) return null;
	config.links = config.links.filter((link) => comparablePath(link.path) !== comparablePath(path));
	if (config.links.length === 0) {
		const file = projectFoldersFile();
		if (existsSync(file)) unlinkSync(file);
	} else {
		writeProjectFoldersConfig(config);
	}
	return match;
}

export function findProjectFolderLink(
	folderPath: string | undefined = process.cwd(),
): ProjectFolderMatch | null {
	const target = normalizeFolderPath(folderPath);
	const matches = readProjectFoldersConfig()
		.links.filter((link) => isParentOrSame(link.path, target))
		.sort((a, b) => comparablePath(b.path).length - comparablePath(a.path).length);
	const link = matches[0];
	if (!link) return null;
	return {
		link,
		source: comparablePath(link.path) === comparablePath(target) ? "exact" : "parent",
	};
}

function expandHome(input: string): string {
	if (input === "~") return homedirFromEnv();
	if (input.startsWith(`~${sep}`)) return resolve(homedirFromEnv(), input.slice(2));
	if (sep === "\\" && input.startsWith("~/")) return resolve(homedirFromEnv(), input.slice(2));
	return input;
}

function homedirFromEnv(): string {
	return process.env.HOME || homedir();
}

function trimTrailingSeparators(input: string): string {
	let value = input;
	while (value.length > 1 && value.endsWith(sep)) {
		value = value.slice(0, -1);
	}
	return value;
}

function isParentOrSame(parent: string, child: string): boolean {
	const parentPath = comparablePath(normalizeFolderPath(parent));
	const childPath = comparablePath(normalizeFolderPath(child));
	if (parentPath === childPath) return true;
	const rel = relative(parentPath, childPath);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function comparablePath(input: string): string {
	const normalized = trimTrailingSeparators(normalize(input));
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isProjectFolderLink(value: unknown): value is ProjectFolderLink {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ProjectFolderLink>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.project_id === "string" &&
		typeof candidate.project_label === "string" &&
		typeof candidate.linked_at === "string"
	);
}
