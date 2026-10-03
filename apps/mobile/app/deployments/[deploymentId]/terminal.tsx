import { useLocalSearchParams } from "expo-router";
import { TerminalScreen } from "../../../src/features/deployments/terminal";
export default function TerminalRoute() {
	const { deploymentId } = useLocalSearchParams<{ deploymentId?: string | string[] }>();
	return (
		<TerminalScreen deploymentId={typeof deploymentId === "string" ? deploymentId : undefined} />
	);
}
