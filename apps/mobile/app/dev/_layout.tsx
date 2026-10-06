import { Stack } from "expo-router";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
export default function DevLayout() {
	const options = useNativeStackOptions();
	return <Stack screenOptions={options} />;
}
