import { useLocalSearchParams } from "expo-router";
import SharedMediaGallery from "../../src/components/chat/SharedMediaGallery";

/**
 * Shared media screen — hosts the Signal-style Images / Videos / Files / Links
 * gallery for a conversation. Opened from the conversation profile screen.
 * Header options (title, back button, action icons) are managed dynamically
 * by SharedMediaGallery via <Stack.Screen> based on selection state.
 */
export default function ChatSharedMedia() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    tab?: string;
  }>();
  const convId = Number(params.id);
  const initialTab = params.tab;

  return <SharedMediaGallery convId={convId} initialTab={initialTab} />;
}
