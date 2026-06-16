# Push Notifications Implementation Guide

## Overview
Push notifications have been fully implemented for the WorkPulse mobile app. The system sends push notifications for:
- **Incoming calls** (voice & video)
- **New messages** in conversations
- **General app notifications** (task assignments, leave approvals, etc.)

## Architecture

### Backend (Node.js/TypeScript)
- **Service**: `server/services/pushNotifications.ts`
  - Firebase Cloud Messaging (FCM) integration
  - Device token management
  - Notification sending with platform-specific payloads
  
- **Database**: `device_tokens` table
  - Stores user device tokens per platform (iOS/Android/Web)
  - Tracks last seen timestamp for cleanup
  
- **API Endpoint**: `POST /api/auth/device-token`
  - Mobile clients register device tokens after login
  - Upserts tokens to handle device reinstalls

- **WebSocket Integration**:
  - Call notifications sent via `pushNotifications.sendCallNotification()`
  - Message notifications sent via `pushNotifications.sendMessageNotification()`
  - General notifications sent via `pushNotifications.sendNotificationAlert()`

### Mobile (React Native/Expo)
- **Service**: `mobile/src/services/pushNotificationService.ts`
  - Handles FCM token acquisition via Expo
  - Manages notification permissions
  - Stores device token in secure storage
  - Provides `usePushNotifications()` hook

- **Listeners**:
  - `PushNotificationInitializer.tsx` - Initializes FCM on app startup
  - `PushNotificationListener.tsx` - Routes incoming push notifications to handlers
  
## Setup Instructions

### 1. Create Firebase Project
```bash
# Go to https://console.firebase.google.com
# Create a new project named "WorkPulse"
# Enable Firebase Cloud Messaging (FCM)
# Create a service account for server communication
```

### 2. Get Service Account Key
```bash
# In Firebase Console:
# 1. Go to Project Settings → Service Accounts
# 2. Click "Generate New Private Key"
# 3. Download the JSON file
# 4. Keep this file secure (contains sensitive credentials)
```

### 3. Set Environment Variables

**Server (.env or deployment config):**
```bash
# Firebase service account key as a JSON string
FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
```

**Production Deployment (Railway/Docker):**
```bash
# Set via environment variables in deployment dashboard
FIREBASE_SERVICE_ACCOUNT_KEY=<paste the full JSON>
```

### 4. Run Database Migration
```bash
# The migration adds the device_tokens table
npm run migrate

# Or manually run for a tenant:
# The migration is applied automatically on server startup
```

### 5. Build and Deploy
```bash
# Backend
npm run build
npm start

# Mobile (EAS Build for production)
eas build --platform android
eas build --platform ios

# Or local testing with Expo
npm run android   # or npm run ios
```

### 6. Test on Device

**Android:**
```bash
# Build and run on Android device/emulator
npx expo run:android

# Push notifications require:
# - Android 5.0+ (API level 21+)
# - Google Play Services installed
# - Google account configured
```

**iOS:**
```bash
# Build and run on iOS device
npx expo run:ios

# Push notifications require:
# - Apple Developer account
# - APNs certificate configured in Firebase
# - Real iOS device (not simulator)
```

## Testing Push Notifications

### 1. Register a Device Token
```bash
# After login, the device token is automatically sent to:
POST /api/auth/device-token
{
  "deviceToken": "ExponentPushToken[...]",
  "platform": "android" | "ios" | "web"
}
```

### 2. Verify Token Registration
```bash
# Query the database
SELECT * FROM device_tokens WHERE user_id = <your_id>;
```

### 3. Test Call Notifications
- Open app on Device A (as User A)
- Open another device/browser as User B
- User B initiates a call to User A
- Device A should receive a push notification

### 4. Test Message Notifications
- Open app on Device A (as User A) with the app backgrounded
- Send a message to User A from another device
- Device A should receive a push notification

### 5. Test General Notifications
- Create a notification event (task assignment, leave approval, etc.)
- User should receive a push notification on backgrounded app

## Notification Payloads

### Incoming Call
```json
{
  "notification": {
    "title": "Incoming Video Call",
    "body": "John Doe is calling..."
  },
  "data": {
    "callId": "123",
    "conversationId": "456",
    "callType": "video",
    "callerId": "789"
  }
}
```

### New Message
```json
{
  "notification": {
    "title": "John Doe",
    "body": "Hey, how are you?"
  },
  "data": {
    "conversationId": "456",
    "messageId": "321",
    "senderId": "789"
  }
}
```

### App Notification
```json
{
  "notification": {
    "title": "Task Assigned",
    "body": "You've been assigned a new task"
  },
  "data": {
    "notificationId": "999",
    "type": "task_assigned"
  }
}
```

## Troubleshooting

### No Push Notifications Received
1. **Check device token registration**: Query `device_tokens` table
2. **Check Firebase credentials**: Verify `FIREBASE_SERVICE_ACCOUNT_KEY` is set
3. **Check app permissions**: User must grant notification permission on first launch
4. **Check network**: Device must be connected to internet
5. **Check logs**: Look for errors in server logs and mobile app console

### Firebase Errors
- **"Invalid service account"**: JSON format is wrong or credentials are invalid
- **"Missing FCM permission"**: Firebase project needs FCM enabled
- **"Invalid registration token"**: Token is expired or malformed (will be cleaned up)

### iOS Specific
- **"APNs certificate not configured"**: Upload Apple's APNs certificate to Firebase
- **"Running on simulator"**: iOS simulator doesn't support push notifications (use real device)
- **"App in foreground"**: Configure notification handler in `pushNotificationService.ts`

### Android Specific
- **"Google Play Services not available"**: Requires Google Play Services
- **"Missing permissions"**: Check `android.permission.POST_NOTIFICATIONS` in Manifest (Android 13+)

## Security Considerations

1. **Token Storage**: Device tokens are stored in plaintext (encrypted at rest by default)
2. **API Auth**: Device token endpoint requires user authentication
3. **Token Rotation**: Tokens are invalidated after ~1 year of inactivity
4. **Credentials**: Firebase service account key should never be committed to git
5. **Payload**: Avoid sending sensitive data in notification payloads

## Performance Impact

- **Database**: One row per device token (typically 1-3 per user)
- **Network**: Negligible - FCM handles all network traffic
- **Backend**: Push notification sending is async and non-blocking
- **Mobile**: Minimal battery impact - handled by system notification service

## Future Enhancements

1. **Rich Notifications**: Add images, actions, and deep links
2. **Notification Channels**: Android-specific channels for different notification types
3. **User Preferences**: Allow users to customize notification settings per event type
4. **Do Not Disturb**: Respect OS-level quiet hours
5. **Notification History**: Store and display notification history in app
6. **Analytics**: Track notification delivery and user engagement

## Rollback Plan

If push notifications cause issues:

1. **Disable sending**: Comment out `pushNotifications.send*()` calls
2. **Keep storage**: Device tokens remain stored for re-enabling
3. **Revert migration**: Remove `device_tokens` table if needed
4. **Rollback code**: Git revert the push notification commits

Push notifications are non-critical - the app works fine without them.

## References

- [Firebase Cloud Messaging](https://firebase.google.com/docs/cloud-messaging)
- [Expo Push Notifications](https://docs.expo.dev/push-notifications/overview/)
- [FCM Payload Format](https://firebase.google.com/docs/cloud-messaging/concept-options)
- [APNs Setup Guide](https://firebase.google.com/docs/cloud-messaging/ios/certs)
