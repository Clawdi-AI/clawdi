import { useLocalSearchParams } from "expo-router";
import { TerminalScreen } from "@/hosted/agents/hosted-terminal-panel";
export default function TerminalRoute() {
	const { deploymentId } = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	return (
		<TerminalScreen deploymentId={typeof deploymentId === "string" ? deploymentId : undefined} />
	);
}
