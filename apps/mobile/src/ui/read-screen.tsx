import type { ReactNode } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

const AppSafeAreaView = withUniwind(SafeAreaView);

export function ReadScreen({ children }: { children: ReactNode }) {
	return (
		<AppSafeAreaView edges={["top", "bottom", "left", "right"]} className="flex-1 bg-background">
			{children}
		</AppSafeAreaView>
	);
}
