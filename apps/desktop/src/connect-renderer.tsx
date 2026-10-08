import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ClawdiDesktopConnectBridge } from "@clawdi/shared/desktop";
import { createRoot } from "react-dom/client";
import { ConnectApp } from "./connect-app";

declare global {
	interface Window {
		clawdiConnect?: ClawdiDesktopConnectBridge;
	}
}

// Follow the OS appearance with the same `.dark` class the Web theme uses.
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyColorScheme = () =>
	document.documentElement.classList.toggle("dark", darkScheme.matches);
applyColorScheme();
darkScheme.addEventListener("change", applyColorScheme);

const root = document.getElementById("root");
if (!root) throw new Error("Clawdi connect root is missing.");
if (!window.clawdiConnect) throw new Error("Clawdi renderer bridge is unavailable.");
// The renderer CSP has no 'unsafe-inline' styles; connect-renderer.css carries
// the rules Base UI would otherwise inject (https://base-ui.com/react/utils/csp-provider).
createRoot(root).render(
	<CSPProvider disableStyleElements>
		<ConnectApp bridge={window.clawdiConnect} />
	</CSPProvider>,
);
