import { Stack, useLocalSearchParams } from "expo-router";
import SharedMediaGallery from "../../src/components/chat/SharedMediaGallery";

/**
 * Shared media screen — hosts the Signal-style Media / Files / Links gallery
 * for a conversation. Opened from the conversation profile screen.
 */
export default function ChatSharedMedia() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    tab?: "media" | "files" | "links";
  }>();
  const convId = Number(params.id);
  const initialTab = params.tab || "media";

  return (
    <>
      <Stack.Screen options={{ title: "Shared media" }} />
      <SharedMediaGallery convId={convId} initialTab={initialTab} />
    </>
  );
}