import * as tar from "tar";
import { validateNativeArchive } from "../src/lib/native-activation.ts";

// Publication policy is stricter than installation of existing releases.
export async function validateNativePublicationArchive(archive) {
	await validateNativeArchive(archive);
	let forbiddenPath;
	let hasLocalSkill = false;
	await new Promise((resolve, reject) => {
		const stream = tar.list({
			gzip: true,
			strict: true,
			onReadEntry(entry) {
				const path = entry.path;
				if (path === "skills/hosted-versions/2/clawdi/SKILL.md" && entry.type === "File")
					hasLocalSkill = true;
				if (
					path.split("/").includes("__pycache__") ||
					path.endsWith(".pyc") ||
					path.endsWith(".pyo")
				) {
					forbiddenPath ??= path;
				}
				entry.resume();
			},
		});
		stream.on("end", resolve);
		stream.on("error", reject);
		stream.end(archive);
	});
	if (!hasLocalSkill) throw new Error("native publication is missing the local MCP Skill");
	if (forbiddenPath) {
		throw new Error(
			`native publication archive contains Python cache or bytecode: ${forbiddenPath}`,
		);
	}
}
