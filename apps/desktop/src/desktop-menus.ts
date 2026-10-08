import type { MenuItemConstructorOptions } from "electron";

export type DesktopSyncStatus =
	| "checking"
	| "unavailable"
	| "signed-out"
	| "off"
	| "running"
	| "attention";

export interface DesktopMenuState {
	platform: NodeJS.Platform;
	appName: string;
	/** Present while the bundled CLI holds an OAuth sign-in. */
	account: { email: string | null } | null;
	syncStatus: DesktopSyncStatus;
	syncChecked: boolean;
	syncToggleEnabled: boolean;
	/** A daemon or sign-in operation is running; quitting or signing out must wait. */
	busy: boolean;
	/** Update status and actions, built by the update controller owner. */
	updateItems: MenuItemConstructorOptions[];
	/** macOS login item; omitted on other platforms. */
	loginItem?: { checked: boolean; enabled: boolean; note: string | null };
}

export interface DesktopMenuActions {
	openDashboard(): void;
	connectAgents(): void;
	fixSync(): void;
	excludeProjects(): void;
	setSync(enabled: boolean): void;
	setLaunchAtLogin(enabled: boolean): void;
	openDocs(): void;
	contactSupport(): void;
	showLogs(): void;
	signOut(): void;
	quit(): void;
}

const SYNC_STATUS_LABELS: Record<DesktopSyncStatus, string> = {
	checking: "Sync: Checking…",
	unavailable: "Sync: Unavailable",
	"signed-out": "Sync: Sign In Required",
	off: "Sync: Off",
	running: "Sync: Running",
	attention: "Sync: Needs Attention",
};

export function desktopSyncStatusLabel(status: DesktopSyncStatus): string {
	return SYNC_STATUS_LABELS[status];
}

/** Native menus use Title Case (macOS HIG); see the copy style guide. */
export function trayMenuTemplate(
	state: DesktopMenuState,
	actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
	const template: MenuItemConstructorOptions[] = [
		...accountItems(state),
		{ label: desktopSyncStatusLabel(state.syncStatus), enabled: false },
		{
			type: "checkbox",
			label: "Sync",
			checked: state.syncChecked,
			enabled: state.syncToggleEnabled,
			click: (item) => actions.setSync(item.checked),
		},
		{ type: "separator" },
		...navigationItems(state, actions),
		...withSeparator(state.updateItems),
	];
	if (state.loginItem) {
		template.push(
			{ type: "separator" },
			{
				type: "checkbox",
				label: "Open Clawdi at Login",
				checked: state.loginItem.checked,
				enabled: state.loginItem.enabled,
				click: (item) => actions.setLaunchAtLogin(item.checked),
			},
		);
		if (state.loginItem.note) template.push({ label: state.loginItem.note, enabled: false });
	}
	template.push(
		{ type: "separator" },
		{ label: "Help", submenu: helpItems(actions) },
		...signOutItems(state, actions),
		{ label: "Quit Clawdi", enabled: !state.busy, click: actions.quit },
	);
	return template;
}

export function applicationMenuTemplate(
	state: DesktopMenuState,
	actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
	const mac = state.platform === "darwin";
	const quit: MenuItemConstructorOptions = { role: "quit", enabled: !state.busy };
	const fileMenu: MenuItemConstructorOptions = {
		label: "File",
		submenu: [
			...withTrailingSeparator(accountItems(state)),
			...navigationItems(state, actions),
			...withSeparator(signOutItems(state, actions)),
			...(mac ? [] : [...withSeparator(state.updateItems), { type: "separator" as const }, quit]),
		],
	};
	const template: MenuItemConstructorOptions[] = [
		fileMenu,
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "close" },
				{ role: "minimize" },
				{ role: "zoom" },
				...(mac ? ([{ type: "separator" }, { role: "front" }] as const) : []),
			],
		},
		{ role: "help", submenu: helpItems(actions) },
	];
	if (mac) {
		template.unshift({
			label: state.appName,
			submenu: [
				{ role: "about" },
				...withSeparator(state.updateItems),
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				quit,
			],
		});
	}
	return template;
}

function accountItems(state: DesktopMenuState): MenuItemConstructorOptions[] {
	if (!state.account) return [];
	return [
		{
			label: state.account.email ? `Signed In as ${state.account.email}` : "Signed In",
			enabled: false,
		},
	];
}

function navigationItems(
	state: DesktopMenuState,
	actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
	return [
		{ label: "Open Dashboard", click: actions.openDashboard },
		{ label: "Connect Agents…", click: actions.connectAgents },
		...(state.syncStatus === "attention" ? [{ label: "Fix Sync…", click: actions.fixSync }] : []),
		{ label: "Exclude Projects…", click: actions.excludeProjects },
	];
}

function signOutItems(
	state: DesktopMenuState,
	actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
	if (!state.account) return [];
	return [{ label: "Sign Out", enabled: !state.busy, click: actions.signOut }];
}

function helpItems(actions: DesktopMenuActions): MenuItemConstructorOptions[] {
	return [
		{ label: "Clawdi Docs", click: actions.openDocs },
		{ label: "Contact Support", click: actions.contactSupport },
		{ type: "separator" },
		{ label: "Show Logs", click: actions.showLogs },
	];
}

function withSeparator(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return items.length > 0 ? [{ type: "separator" }, ...items] : [];
}

function withTrailingSeparator(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
	return items.length > 0 ? [...items, { type: "separator" }] : [];
}
