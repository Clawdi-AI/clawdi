import { agentSkillsHaveRetryableInstallFailure } from "@clawdi/shared/view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function SkillUpdateFailureAlert({
	managed,
	hosted,
}: {
	managed: Parameters<typeof agentSkillsHaveRetryableInstallFailure>[0];
	hosted: Parameters<typeof agentSkillsHaveRetryableInstallFailure>[1];
}) {
	if (!agentSkillsHaveRetryableInstallFailure(managed, hosted)) return null;
	return (
		<Alert variant="destructive">
			<AlertTitle>Couldn't update skills</AlertTitle>
			<AlertDescription>We'll retry automatically.</AlertDescription>
		</Alert>
	);
}
