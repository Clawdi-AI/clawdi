import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { DesktopCodeSignature } from "./update-policy";

export async function readMacCodeSignature(
	executablePath: string,
): Promise<DesktopCodeSignature | null> {
	const appBundle = resolve(dirname(executablePath), "..", "..");
	let output: string;
	try {
		await codesign(["--verify", "--deep", "--strict", appBundle]);
		output = await codesignDetails(appBundle);
	} catch {
		return null;
	}
	const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map(
		(match) => match[1]?.trim() ?? "",
	);
	const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
	return {
		authorities: authorities.filter(Boolean),
		teamIdentifier: teamIdentifier && teamIdentifier !== "not set" ? teamIdentifier : null,
	};
}

function codesignDetails(appBundle: string): Promise<string> {
	return codesign(["-dv", "--verbose=4", appBundle]);
}

function codesign(args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			"codesign",
			args,
			{ encoding: "utf8", timeout: 15_000, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) reject(error);
				else resolvePromise(`${stdout}\n${stderr}`);
			},
		);
	});
}
