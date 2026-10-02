import { Button, Column, Host, Switch, TextInput } from "@expo/ui";
import { Card, Chip, Spinner } from "heroui-native";
import { useState } from "react";
import { Text, View } from "react-native";

export default function ProbeGallery() {
	const [enabled, setEnabled] = useState(false);
	return (
		<View className="flex-1 gap-4 p-6">
			<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
				<Column spacing={8}>
					<TextInput placeholder="Compatibility fixture" />
					<Switch label="Native system control" value={enabled} onValueChange={setEnabled} />
					<Button label="Toggle fixture" onPress={() => setEnabled((current) => !current)} />
				</Column>
			</Host>
			<Card>
				<Text className="text-foreground">Branded component probe, not a product screen</Text>
				<Chip>
					<Chip.Label>Compatibility only</Chip.Label>
				</Chip>
				<Spinner />
			</Card>
		</View>
	);
}
