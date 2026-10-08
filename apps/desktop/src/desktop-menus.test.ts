import { expect, mock, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import {
	applicationMenuTemplate,
	type DesktopMenuActions,
	type DesktopMenuState,
	trayMenuTemplate,
} from "./desktop-menus";

function actions(): DesktopMenuActions {
	return {
		openDashboard: mock(),
		connectAgents: mock(),
		fixSync: mock(),
		excludeProjects: mock(),
		setSync: mock(),
		setLaunchAtLogin: mock(),
		openDocs: mock(),
		contactSupport: mock(),
		showLogs: mock(),
		signOut: mock(),
		quit: mock(),
	};
}

function state(overrides: Partial<DesktopMenuState> = {}): DesktopMenuState {
	return {
		platform: "darwin",
		appName: "Clawdi",
		account: { email: "jamie@example.com" },
		syncStatus: "running",
		syncChecked: true,
		syncToggleEnabled: true,
		busy: false,
		updateItems: [],
		...overrides,
	};
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return items.flatMap((item) => [
		item,
		...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
	]);
}

function find(items: MenuItemConstructorOptions[], label: string) {
	return flatten(items).find((item) => item.label === label);
}

const click = (item: MenuItemConstructorOptions | undefined) =>
	(item?.click as (() => void) | undefined)?.();

test("the tray leads with the signed-in account and offers every Desktop task", () => {
	const handlers = actions();
	const tray = trayMenuTemplate(state(), handlers);
	expect(tray[0]).toEqual({ label: "Signed In as jamie@example.com", enabled: false });
	expect(tray[1]).toEqual({ label: "Sync: Running", enabled: false });
	for (const label of [
		"Open Dashboard",
		"Connect Agents…",
		"Exclude Projects…",
		"Clawdi Docs",
		"Contact Support",
		"Show Logs",
		"Sign Out",
		"Quit Clawdi",
	]) {
		expect(find(tray, label)).toBeDefined();
	}
	expect(find(tray, "Fix Sync…")).toBeUndefined();
	click(find(tray, "Exclude Projects…"));
	click(find(tray, "Show Logs"));
	expect(handlers.excludeProjects).toHaveBeenCalledTimes(1);
	expect(handlers.showLogs).toHaveBeenCalledTimes(1);
});

test("Fix Sync appears only when sync needs attention", () => {
	const handlers = actions();
	const tray = trayMenuTemplate(state({ syncStatus: "attention" }), handlers);
	expect(find(tray, "Sync: Needs Attention")).toBeDefined();
	click(find(tray, "Fix Sync…"));
	expect(handlers.fixSync).toHaveBeenCalledTimes(1);
	for (const syncStatus of ["checking", "unavailable", "signed-out", "off", "running"] as const) {
		expect(find(trayMenuTemplate(state({ syncStatus }), handlers), "Fix Sync…")).toBeUndefined();
	}
});

test("signed-out menus hide the account and Sign Out", () => {
	for (const template of [
		trayMenuTemplate(state({ account: null, syncStatus: "signed-out" }), actions()),
		applicationMenuTemplate(state({ account: null, syncStatus: "signed-out" }), actions()),
	]) {
		expect(flatten(template).some((item) => item.label?.startsWith("Signed In"))).toBe(false);
		expect(find(template, "Sign Out")).toBeUndefined();
	}
});

test("busy operations block Sign Out and Quit", () => {
	const tray = trayMenuTemplate(state({ busy: true }), actions());
	expect(find(tray, "Sign Out")?.enabled).toBe(false);
	expect(find(tray, "Quit Clawdi")?.enabled).toBe(false);
	const appMenu = applicationMenuTemplate(state({ busy: true }), actions());
	expect(flatten(appMenu).find((item) => item.role === "quit")?.enabled).toBe(false);
});

test.each(["darwin", "win32", "linux"] as const)(
	"%s application menu has no dashboard accelerator and includes Help",
	(platform) => {
		const update: MenuItemConstructorOptions = { label: "Check for Updates…" };
		const template = applicationMenuTemplate(state({ platform, updateItems: [update] }), actions());
		const items = flatten(template);
		expect(items.some((item) => item.accelerator)).toBe(false);
		expect(items.some((item) => item.label === "Open Dashboard in Browser")).toBe(false);
		expect(find(template, "Open Dashboard")).toBeDefined();
		expect(find(template, "Signed In as jamie@example.com")?.enabled).toBe(false);
		expect(items.filter((item) => item === update)).toHaveLength(1);
		const help = template.find((item) => item.role === "help");
		expect(Array.isArray(help?.submenu) && help.submenu.map((item) => item.label)).toEqual([
			"Clawdi Docs",
			"Contact Support",
			undefined,
			"Show Logs",
		]);
		expect(template[0]?.label).toBe(platform === "darwin" ? "Clawdi" : "File");
	},
);

test.each(["darwin", "win32"] as const)(
	"%s shows Open Clawdi at Login in the tray and the application menu",
	(platform) => {
		const handlers = actions();
		const loginItem = { checked: false, enabled: true, note: "Login Item Requires Approval" };
		for (const template of [
			trayMenuTemplate(state({ platform, loginItem }), handlers),
			applicationMenuTemplate(state({ platform, loginItem }), handlers),
		]) {
			const item = find(template, "Open Clawdi at Login");
			expect(item?.type).toBe("checkbox");
			expect(find(template, "Login Item Requires Approval")?.enabled).toBe(false);
			(item?.click as ((menuItem: { checked: boolean }) => void) | undefined)?.({ checked: true });
		}
		expect(handlers.setLaunchAtLogin).toHaveBeenCalledWith(true);
		expect(handlers.setLaunchAtLogin).toHaveBeenCalledTimes(2);
	},
);

test("menus omit the login item where it is unsupported", () => {
	const linux = state({ platform: "linux" });
	expect(find(trayMenuTemplate(linux, actions()), "Open Clawdi at Login")).toBeUndefined();
	expect(find(applicationMenuTemplate(linux, actions()), "Open Clawdi at Login")).toBeUndefined();
});
