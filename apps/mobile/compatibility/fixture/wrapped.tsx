import { Text, View } from "react-native";
import { withUniwind } from "uniwind";

const StyledView = withUniwind(View);
const StyledText = withUniwind(Text);

export function OfficialWrapperProbe() {
	return (
		<StyledView className="p-4">
			<StyledText className="text-foreground">Official typed wrapper probe</StyledText>
		</StyledView>
	);
}
