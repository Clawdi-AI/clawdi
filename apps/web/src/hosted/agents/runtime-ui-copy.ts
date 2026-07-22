export interface RuntimeUiAuthCopy {
	title: string;
	description: string;
	openSecureDashboard: string;
	openHermesDashboard: string;
}

const COPY: Record<"en" | "zh-CN" | "zh-TW", RuntimeUiAuthCopy> = {
	en: {
		title: "Open Hermes with your dashboard password",
		description:
			"Hermes opens in a new window. Your deployment password is copied automatically; sign in with username admin.",
		openSecureDashboard: "Copy password & open",
		openHermesDashboard: "Copy password & open Hermes",
	},
	"zh-CN": {
		title: "使用 Dashboard 密码打开 Hermes",
		description: "Hermes 会在新窗口中打开。部署密码将自动复制，请使用用户名 admin 登录。",
		openSecureDashboard: "复制密码并打开",
		openHermesDashboard: "复制密码并打开 Hermes",
	},
	"zh-TW": {
		title: "使用 Dashboard 密碼開啟 Hermes",
		description: "Hermes 會在新視窗中開啟。部署密碼將自動複製，請使用使用者名稱 admin 登入。",
		openSecureDashboard: "複製密碼並開啟",
		openHermesDashboard: "複製密碼並開啟 Hermes",
	},
};

export function hermesPasswordUiCopy(locale: string | undefined): RuntimeUiAuthCopy {
	const normalized = locale?.replace("_", "-").toLowerCase() ?? "en";
	if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-hant") {
		return COPY["zh-TW"];
	}
	if (normalized === "zh" || normalized.startsWith("zh-")) return COPY["zh-CN"];
	return COPY.en;
}

export function browserHermesPasswordUiCopy(): RuntimeUiAuthCopy {
	return hermesPasswordUiCopy(typeof navigator === "undefined" ? undefined : navigator.language);
}

export function browserOpenClawNativeUiCopy(): RuntimeUiAuthCopy {
	const locale = typeof navigator === "undefined" ? undefined : navigator.language;
	const normalized = locale?.replace("_", "-").toLowerCase() ?? "en";
	if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-hant") {
		return {
			title: "在新視窗中開啟 OpenClaw",
			description: "OpenClaw 原生裝置驗證不可嵌入此頁面。請在新視窗中完成登入與裝置配對。",
			openSecureDashboard: "開啟安全 Control UI",
			openHermesDashboard: "開啟 OpenClaw Control UI",
		};
	}
	if (normalized === "zh" || normalized.startsWith("zh-")) {
		return {
			title: "在新窗口中打开 OpenClaw",
			description: "OpenClaw 原生设备验证不能嵌入此页面。请在新窗口中完成登录和设备配对。",
			openSecureDashboard: "打开安全 Control UI",
			openHermesDashboard: "打开 OpenClaw Control UI",
		};
	}
	return {
		title: "Open OpenClaw in a new window",
		description:
			"OpenClaw's native device authentication cannot be embedded here. Open the Control UI to authenticate and complete device pairing.",
		openSecureDashboard: "Open secure Control UI",
		openHermesDashboard: "Open OpenClaw Control UI",
	};
}
