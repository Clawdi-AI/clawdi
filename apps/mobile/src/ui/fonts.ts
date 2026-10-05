import { Geist_400Regular } from "@expo-google-fonts/geist/400Regular";
import { Geist_500Medium } from "@expo-google-fonts/geist/500Medium";
import { Geist_600SemiBold } from "@expo-google-fonts/geist/600SemiBold";
import { Geist_700Bold } from "@expo-google-fonts/geist/700Bold";
import { GeistMono_400Regular } from "@expo-google-fonts/geist-mono/400Regular";
import { GeistMono_500Medium } from "@expo-google-fonts/geist-mono/500Medium";
import { useFonts } from "expo-font";

/** Family names referenced by the `--font-*` tokens in global.css. */
export function useAppFonts() {
	const [loaded, error] = useFonts({
		"Geist-Regular": Geist_400Regular,
		"Geist-Medium": Geist_500Medium,
		"Geist-SemiBold": Geist_600SemiBold,
		"Geist-Bold": Geist_700Bold,
		"GeistMono-Regular": GeistMono_400Regular,
		"GeistMono-Medium": GeistMono_500Medium,
	});
	// A font failure must not block the app; system fonts are the fallback.
	return loaded || error !== null;
}
