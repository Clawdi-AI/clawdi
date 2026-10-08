import type { NotificationConstructorOptions } from "electron";

export function desktopUpdateNotification(
	version: string,
	ready: boolean,
): NotificationConstructorOptions {
	return {
		title: "Clawdi Desktop",
		body: ready
			? `Clawdi Desktop ${version} is ready — restart to update`
			: `Clawdi Desktop ${version} is available — download the new version`,
	};
}

export function desktopUpdateDownloadUrl(version: string): string {
	if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))
		throw new Error("Invalid Desktop download version.");
	return `https://github.com/Clawdi-AI/clawdi/releases/tag/desktop-v${encodeURIComponent(version)}`;
}
