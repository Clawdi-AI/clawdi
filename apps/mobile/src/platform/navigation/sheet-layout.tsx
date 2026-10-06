import { SafeAreaProvider } from "react-native-safe-area-context";
import { SignedInLayout } from "@/platform/navigation/signed-in-layout";

/** Measure insets relative to the presented sheet instead of the full tab window. */
export default function SheetLayout() {
	return (
		<SafeAreaProvider>
			<SignedInLayout />
		</SafeAreaProvider>
	);
}
