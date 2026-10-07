import { Redirect, Stack } from "expo-router";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
export default function DevLayout() {
	const options = useNativeStackOptions();
	if (!__DEV__) return <Redirect href="/" />;
	return <Stack screenOptions={options} />;
}
