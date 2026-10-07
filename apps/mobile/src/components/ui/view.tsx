import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

export const AppView = withUniwind(View);
export const AppImage = withUniwind(Image);
export const AppScrollView = withUniwind(ScrollView);
export const AppPressable = withUniwind(Pressable);
export const AppTextInput = withUniwind(TextInput);
export const AppSafeAreaView = withUniwind(SafeAreaView);
