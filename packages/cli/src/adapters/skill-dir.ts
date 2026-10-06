import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { replaceSkillArchiveTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
	shouldIgnoreUserSkill,
} from "../runtime/managed-skill-reservation";
import type { RawSkill, SkillModule, SyncReadContext } from "./base";
import { SKIP_DIRS, safeSkillDirectoryPath } from "./paths";

interface SkillDirectory {
	key: string;
	dirPath: string;
}

interface SkillDirectoryOptions {
	nested?: boolean;
	acceptKey?: (key: string) => boolean;
}

/** Read-only inventory shared by collection and the daemon's key scan. */
export function enumerateSkillDirs(
	root: string,
	options: SkillDirectoryOptions = {},
): SkillDirectory[] {
	const results: SkillDirectory[] = [];
	const visited = new Set<string>();
	const walk = (dir: string): void => {
		try {
			const canonical = realpathSync(dir);
			if (visited.has(canonical)) return;
			visited.add(canonical);
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
				const dirPath = safeSkillDirectoryPath(root, entry, dir);
				if (!dirPath) continue;
				if (existsSync(join(dirPath, "SKILL.md"))) {
					const key = relative(root, dirPath).replaceAll("\\", "/");
					if (options.acceptKey && !options.acceptKey(key)) continue;
					if (!shouldIgnoreUserSkill(dirPath, key)) results.push({ key, dirPath });
				} else if (options.nested) {
					walk(dirPath);
				}
			}
		} catch {
			// Missing/unreadable directories are omitted, as in the adapter inventories.
		}
	};
	walk(root);
	return results;
}

export function collectSkillsFromDir(
	root: string,
	options: SkillDirectoryOptions = {},
): RawSkill[] {
	migrateLegacyLocalSetupSkill({
		targetDir: join(root, "clawdi"),
		id: "clawdi",
		version: 1,
		digest: managedSkillDirectoryDigest,
	});
	return enumerateSkillDirs(root, options).flatMap(({ key, dirPath }) => {
		try {
			const filePath = join(dirPath, "SKILL.md");
			return [
				{
					skillKey: key,
					name: basename(dirPath),
					content: readFileSync(filePath, "utf-8"),
					filePath,
					directoryPath: dirPath,
					isDirectory: readdirSync(dirPath, { recursive: true }).length > 1,
				},
			];
		} catch {
			return [];
		}
	});
}

export function flatSkillModule(
	options: SkillDirectoryOptions & {
		root: () => string;
		sharedPath?: SkillModule["sharedPath"];
		write?: Pick<SkillModule, "writeArchive" | "writeSharedArchive">;
	},
): SkillModule {
	const sharedPath =
		options.sharedPath ?? ((key, owner) => join(options.root(), `${key}__${owner}`));
	return {
		collect: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			return collectSkillsFromDir(options.root(), options);
		},
		listKeys: async (context?: SyncReadContext) => {
			context?.signal.throwIfAborted();
			return enumerateSkillDirs(options.root(), options).map(({ key }) => key);
		},
		path: (key) => join(options.root(), key, "SKILL.md"),
		rootDir: options.root,
		sharedPath,
		remove: async (key) => {
			const target = join(options.root(), key);
			mutateUserSkillTarget(target, key, () => {
				if (existsSync(target)) rmSync(target, { recursive: true, force: true });
			});
		},
		writeArchive:
			options.write?.writeArchive ??
			(async (key, bytes) => {
				const root = options.root();
				const target = join(root, key);
				await replaceSkillArchiveTarGz(key, root, target, bytes, undefined, (mutation) =>
					mutateUserSkillTarget(target, key, mutation),
				);
			}),
		writeSharedArchive:
			options.write?.writeSharedArchive ??
			(async (key, owner, bytes) => {
				const target = sharedPath(key, owner);
				await replaceSkillArchiveTarGz(key, options.root(), target, bytes, undefined, (mutation) =>
					mutateUserSkillTarget(target, basename(target), mutation),
				);
			}),
	};
}
