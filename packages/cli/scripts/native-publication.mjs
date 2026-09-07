import * as tar from "tar";
import { validateNativeArchive } from "../src/lib/native-activation.ts";

// Publication policy is stricter than installation of existing releases.
export async function validateNativePublicationArchive(archive) {
	await validateNativeArchive(archive);
	let forbiddenPath;
	await new Promise((resolve, reject) => {
		const stream = tar.list({
			gzip: true,
			strict: true,
			onReadEntry(entry) {
				const path = entry.path;
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
	if (forbiddenPath) {
		throw new Error(
			`native publication archive contains Python cache or bytecode: ${forbiddenPath}`,
		);
	}
}
