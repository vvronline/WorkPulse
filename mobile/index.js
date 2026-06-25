import 'expo-router/entry';
import messaging from '@react-native-firebase/messaging';
import { displayMessageNotification } from './src/services/notifeeService';
import notifee from '@notifee/react-native';
import { handleNotifeeEvent } from './src/services/notifeeService';

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    const data = remoteMessage?.data;
    if (data?.type === 'chat') {
        await displayMessageNotification({
            conversationId: String(data.conversationId),
            senderName: data.senderName ? String(data.senderName) : undefined,
            senderAvatar: data.senderAvatar ? String(data.senderAvatar) : undefined,
            preview: data.preview ? String(data.preview) : undefined,
        });
    }
});

notifee.onBackgroundEvent(async ({ type, detail }) => {
    await handleNotifeeEvent(type, detail);
});

export default messaging;