# Quickstart - Native Incoming Call & Notification Parity

## 1. Install planned dependencies

From repository root:

```powershell
Set-Location D:\Learnings\WorkPulse\mobile
npm install react-native-callkeep @react-native-firebase/app @react-native-firebase/messaging
```

Optional Android UX enhancement:

```powershell
npm install @notifee/react-native
```

## 2. Generate native projects (Expo custom workflow)

```powershell
Set-Location D:\Learnings\WorkPulse\mobile
npx expo prebuild
```

## 3. Configure native permissions/capabilities

### Android
- Ensure:
  - `POST_NOTIFICATIONS`
  - `USE_FULL_SCREEN_INTENT`
  - `FOREGROUND_SERVICE_PHONE_CALL`
  - `WAKE_LOCK`
- Configure incoming-call notification/callkeep service bindings.

### iOS
- Enable:
  - Push Notifications
  - Background Modes: `voip`, `remote-notification`
  - CallKit/VoIP entitlements needed by chosen implementation

## 4. Wire server push payloads

- Extend `server/services/pushNotifications.ts` payload fields:
  - `callId`, `conversationId`, `callerId`, `callerName`, `callerAvatar`, `callType`, `tenantId`, `expiresAt`
- Ensure high-priority delivery and collapse keys for calls/messages.

## 5. Wire mobile handlers

- Background push handler receives call invite.
- CallKeep displays incoming call UI.
- Answer/Reject events bridge to existing websocket signaling (`call_accept`, `call_reject`) with idempotent retry.
- Route accepted calls to `mobile/app/call/[conversationId].tsx`.
- Reconcile badge from authoritative unread counts after:
  - incoming message push
  - read action
  - app foreground transition

## 6. Verification checklist

### Incoming call parity
1. Terminate app.
2. Trigger call invite.
3. Confirm native incoming call UI appears.
4. Tap Answer, verify transition to connecting.
5. Tap Reject, verify caller sees rejected/missed behavior and ringing stops on other devices.

### Message + badge parity
1. Background app; send message.
2. Confirm status-bar notification appears.
3. Confirm launcher dot/badge increments.
4. Open/read conversation; confirm badge decrements without restart.

## 7. Test commands

```powershell
Set-Location D:\Learnings\WorkPulse\mobile
npx tsc --noEmit -p tsconfig.json

Set-Location D:\Learnings\WorkPulse\server
npm run typecheck
npm run test
```
