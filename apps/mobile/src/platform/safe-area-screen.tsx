import { HeaderHeightContext } from "expo-router/react-navigation";
import { type ReactNode, useContext } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

const AppSafeAreaView = withUniwind(SafeAreaView);

export function SafeAreaScreen({ children, testID }: { children: ReactNode; testID?: string }) {
	const headerHeight = useContext(HeaderHeightContext);
	return (
		<AppSafeAreaView
			testID={testID}
			edges={headerHeight ? ["left", "right"] : ["top", "bottom", "left", "right"]}
			className="flex-1 bg-background"
		>
			{children}
		</AppSafeAreaView>
	);
}
