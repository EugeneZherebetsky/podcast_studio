import { Stack } from "expo-router";

export default function Layout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: "Player" }} />
      <Stack.Screen name="library" options={{ title: "Library" }} />
      <Stack.Screen name="review" options={{ title: "Review" }} />
    </Stack>
  );
}
