import { useRouter } from "expo-router";
import { useI18n } from "../i18n";
import { NativeButton } from "./native-controls";
import { AppView } from "./primitives";

export function CloudActions() {
	const router = useRouter();
	const t = useI18n();
	return (
		<AppView className="gap-3">
			<NativeButton
				label={t("navigation.createAgent")}
				onPress={() => router.push("/agents/new")}
			/>
			<NativeButton
				label={t("navigation.deployments")}
				onPress={() => router.push("/deployments")}
			/>
			<NativeButton label={t("navigation.billing")} onPress={() => router.push("/billing")} />
			<NativeButton label={t("navigation.skills")} onPress={() => router.push("/skills")} />
			<NativeButton label={t("navigation.memories")} onPress={() => router.push("/memories")} />
			<NativeButton label={t("navigation.projects")} onPress={() => router.push("/projects")} />
		</AppView>
	);
}
