import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopUpdateSiteTargets } from "../src/update-metadata";
import { normalizeDesktopUpdateFeedUrl } from "../src/update-policy";

const directory = process.argv[2];
const siteUrl = normalizeDesktopUpdateFeedUrl(process.env.DESKTOP_UPDATE_SITE_URL);
const output = process.env.GITHUB_OUTPUT;
if (!directory || !siteUrl || !output) {
	throw new Error(
		"A site directory, HTTPS DESKTOP_UPDATE_SITE_URL and GITHUB_OUTPUT are required.",
	);
}

function generatedFiles(relative = ""): string[] {
	return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
		const path = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return generatedFiles(path);
		if (!entry.isFile()) throw new Error(`Unsupported site entry: ${path}.`);
		return [path];
	});
}

// Compare every prepared file, including index.html and any future site content.
// Also check omitted feeds so a pause that removes a channel still deploys.
const files = new Set([
	...generatedFiles(),
	...desktopUpdateSiteTargets.map((target) => target.path),
]);
let changed = false;
for (const path of files) {
	const url = new URL(path.split("/").map(encodeURIComponent).join("/"), siteUrl);
	// curl's exit status covers transport errors; HTTP 404 is handled separately.
	const response = execFileSync(
		"curl",
		[
			"--silent",
			"--show-error",
			"--location",
			"--proto",
			"=https",
			"--proto-redir",
			"=https",
			"--connect-timeout",
			"5",
			"--max-time",
			"15",
			"--header",
			"Cache-Control: no-cache",
			"--write-out",
			"\n%{http_code}",
			url.href,
		],
		{ timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
	);
	const separator = response.lastIndexOf(10);
	const status = response.subarray(separator + 1).toString();
	if (status !== "200" && status !== "404") {
		throw new Error(`Could not compare ${path}: HTTP ${status}.`);
	}
	const local = join(directory, path);
	if (existsSync(local)) {
		if (status === "404" || !readFileSync(local).equals(response.subarray(0, separator)))
			changed = true;
	} else if (status === "200") {
		changed = true;
	}
}

appendFileSync(output, `changed=${changed}\n`);
console.log(
	changed ? "Desktop update site changed." : "Desktop update site is unchanged; skip deployment.",
);
