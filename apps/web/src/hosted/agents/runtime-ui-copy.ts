export interface HermesPasswordUiCopy {
	title: string;
	description: string;
	viewCredentials: string;
	showCredentials: string;
	loadingCredentials: string;
	hideCredentials: string;
	username: string;
	password: string;
	copyUsername: string;
	copyPassword: string;
	usernameCopied: string;
	passwordCopied: string;
	manualCopy: string;
	openDashboard: string;
	credentialErrorTitle: string;
	credentialErrorDescription: string;
}

export interface OpenClawNativeUiCopy {
	title: string;
	description: string;
	openControlUi: string;
	pairingTitle: string;
	pairingDescription: string;
	pairingListCommand: string;
	pairingApproveCommand: string;
	pairingWarning: string;
	openHostedTerminal: string;
	pairingRequestId: string;
	pairingApprove: string;
	pairingApproving: string;
	pairingEmpty: string;
	pairingRefresh: string;
	pairingLoadError: string;
	pairingApproved: string;
	credentialErrorTitle: string;
	credentialErrorDescription: string;
	popupBlockedTitle: string;
	popupBlockedDescription: string;
}

interface RuntimeUiCopyCatalog {
	hermes: HermesPasswordUiCopy;
	openclaw: OpenClawNativeUiCopy;
}

const COPY: Record<"en" | "zh-CN" | "zh-TW", RuntimeUiCopyCatalog> = {
	en: {
		hermes: {
			title: "Open Hermes with explicit credentials",
			description:
				"First show the username and password. Copy each value explicitly, or select it and copy manually, then open Hermes and sign in.",
			viewCredentials: "View Hermes credentials",
			showCredentials: "Show Hermes credentials",
			loadingCredentials: "Loading credentials…",
			hideCredentials: "Hide credentials",
			username: "Username",
			password: "Password",
			copyUsername: "Copy Hermes username",
			copyPassword: "Copy Hermes password",
			usernameCopied: "Hermes username copied",
			passwordCopied: "Hermes password copied",
			manualCopy: "Couldn’t copy — select the visible value and copy it manually.",
			openDashboard: "Open Hermes Dashboard",
			credentialErrorTitle: "Couldn’t load Hermes credentials",
			credentialErrorDescription: "Select “Show Hermes credentials” to try again.",
		},
		openclaw: {
			title: "Open OpenClaw in a new window",
			description:
				"OpenClaw uses its official token handoff and native device authentication in a top-level Control UI.",
			openControlUi: "Open OpenClaw Control UI",
			pairingTitle: "If the Control UI shows “pairing required”",
			pairingDescription:
				"Open Hosted Terminal, list pending devices, copy that browser’s exact requestId, then approve that requestId:",
			pairingListCommand: "openclaw devices list",
			pairingApproveCommand: "openclaw devices approve <requestId>",
			pairingWarning: "Do not auto-approve a request and do not use --latest.",
			openHostedTerminal: "Open Hosted Terminal",
			pairingRequestId: "Request ID",
			pairingApprove: "Approve this browser",
			pairingApproving: "Approving…",
			pairingEmpty: "No pending browser pairing request yet.",
			pairingRefresh: "Check for pairing request",
			pairingLoadError: "Couldn’t load pending pairing requests.",
			pairingApproved: "Browser pairing approved. Return to the OpenClaw window.",
			credentialErrorTitle: "Couldn’t open OpenClaw",
			credentialErrorDescription: "Please try again.",
			popupBlockedTitle: "Couldn’t open OpenClaw",
			popupBlockedDescription: "Your browser blocked the new window. Allow popups and try again.",
		},
	},
	"zh-CN": {
		hermes: {
			title: "使用显式凭据打开 Hermes",
			description:
				"先显示用户名和密码。请分别显式复制；若剪贴板不可用，也可选中可见内容手工复制。然后打开 Hermes 并登录。",
			viewCredentials: "查看 Hermes 凭据",
			showCredentials: "显示 Hermes 凭据",
			loadingCredentials: "正在加载凭据…",
			hideCredentials: "隐藏凭据",
			username: "用户名",
			password: "密码",
			copyUsername: "复制 Hermes 用户名",
			copyPassword: "复制 Hermes 密码",
			usernameCopied: "已复制 Hermes 用户名",
			passwordCopied: "已复制 Hermes 密码",
			manualCopy: "无法复制——请选中可见内容并手工复制。",
			openDashboard: "打开 Hermes Dashboard",
			credentialErrorTitle: "无法加载 Hermes 凭据",
			credentialErrorDescription: "请选择“显示 Hermes 凭据”重试。",
		},
		openclaw: {
			title: "在新窗口中打开 OpenClaw",
			description: "OpenClaw 在顶层 Control UI 中使用官方 token 交接和原生设备认证。",
			openControlUi: "打开 OpenClaw Control UI",
			pairingTitle: "如果 Control UI 显示“pairing required”",
			pairingDescription:
				"打开 Hosted Terminal，列出待配对设备，复制该浏览器对应的准确 requestId，再批准这个 requestId：",
			pairingListCommand: "openclaw devices list",
			pairingApproveCommand: "openclaw devices approve <requestId>",
			pairingWarning: "不要自动批准请求，也不要使用 --latest。",
			openHostedTerminal: "打开 Hosted Terminal",
			pairingRequestId: "请求 ID",
			pairingApprove: "批准此浏览器",
			pairingApproving: "正在批准…",
			pairingEmpty: "尚无待处理的浏览器配对请求。",
			pairingRefresh: "检查配对请求",
			pairingLoadError: "无法加载待处理的配对请求。",
			pairingApproved: "浏览器配对已批准。请返回 OpenClaw 窗口。",
			credentialErrorTitle: "无法打开 OpenClaw",
			credentialErrorDescription: "请重试。",
			popupBlockedTitle: "无法打开 OpenClaw",
			popupBlockedDescription: "浏览器阻止了新窗口。请允许弹窗后重试。",
		},
	},
	"zh-TW": {
		hermes: {
			title: "使用明確憑證開啟 Hermes",
			description:
				"先顯示使用者名稱和密碼。請分別明確複製；若剪貼簿無法使用，也可選取可見內容手動複製。然後開啟 Hermes 並登入。",
			viewCredentials: "檢視 Hermes 憑證",
			showCredentials: "顯示 Hermes 憑證",
			loadingCredentials: "正在載入憑證…",
			hideCredentials: "隱藏憑證",
			username: "使用者名稱",
			password: "密碼",
			copyUsername: "複製 Hermes 使用者名稱",
			copyPassword: "複製 Hermes 密碼",
			usernameCopied: "已複製 Hermes 使用者名稱",
			passwordCopied: "已複製 Hermes 密碼",
			manualCopy: "無法複製——請選取可見內容並手動複製。",
			openDashboard: "開啟 Hermes Dashboard",
			credentialErrorTitle: "無法載入 Hermes 憑證",
			credentialErrorDescription: "請選擇「顯示 Hermes 憑證」重試。",
		},
		openclaw: {
			title: "在新視窗中開啟 OpenClaw",
			description: "OpenClaw 在頂層 Control UI 中使用官方 token 交接和原生裝置驗證。",
			openControlUi: "開啟 OpenClaw Control UI",
			pairingTitle: "如果 Control UI 顯示「pairing required」",
			pairingDescription:
				"開啟 Hosted Terminal，列出待配對裝置，複製該瀏覽器對應的準確 requestId，再核准這個 requestId：",
			pairingListCommand: "openclaw devices list",
			pairingApproveCommand: "openclaw devices approve <requestId>",
			pairingWarning: "不要自動核准請求，也不要使用 --latest。",
			openHostedTerminal: "開啟 Hosted Terminal",
			pairingRequestId: "請求 ID",
			pairingApprove: "核准此瀏覽器",
			pairingApproving: "正在核准…",
			pairingEmpty: "尚無待處理的瀏覽器配對請求。",
			pairingRefresh: "檢查配對請求",
			pairingLoadError: "無法載入待處理的配對請求。",
			pairingApproved: "瀏覽器配對已核准。請返回 OpenClaw 視窗。",
			credentialErrorTitle: "無法開啟 OpenClaw",
			credentialErrorDescription: "請重試。",
			popupBlockedTitle: "無法開啟 OpenClaw",
			popupBlockedDescription: "瀏覽器阻擋了新視窗。請允許彈出視窗後重試。",
		},
	},
};

function copyForLocale(locale: string | undefined): RuntimeUiCopyCatalog {
	const normalized = locale?.replace("_", "-").toLowerCase() ?? "en";
	if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-hant") {
		return COPY["zh-TW"];
	}
	if (normalized === "zh" || normalized.startsWith("zh-")) return COPY["zh-CN"];
	return COPY.en;
}

function browserLocale(): string | undefined {
	return typeof navigator === "undefined" ? undefined : navigator.language;
}

export function hermesPasswordUiCopy(locale: string | undefined): HermesPasswordUiCopy {
	return copyForLocale(locale).hermes;
}

export function openClawNativeUiCopy(locale: string | undefined): OpenClawNativeUiCopy {
	return copyForLocale(locale).openclaw;
}

export function browserHermesPasswordUiCopy(): HermesPasswordUiCopy {
	return hermesPasswordUiCopy(browserLocale());
}

export function browserOpenClawNativeUiCopy(): OpenClawNativeUiCopy {
	return openClawNativeUiCopy(browserLocale());
}
