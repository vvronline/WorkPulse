export default function useCallActions(state) {
    const {
        user, wsSend,
        activeConv,
        setCallState, callSignalRef, callEndRef,
    } = state;

    const initiateCall = async (callType) => {
        if (!activeConv) return;

        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: callType === 'video' ? { width: 1280, height: 720, facingMode: 'user' } : false
            });
        } catch (err) {
            console.error('Failed to get media:', err);
            const device = callType === 'video' ? 'camera/microphone' : 'microphone';
            if (err?.name === 'NotAllowedError') {
                alert(`${device} access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow ${device}\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site`);
            } else if (err?.name === 'NotFoundError') {
                alert(`No ${device} found. Please connect a ${device} and try again.`);
            } else {
                alert(`Could not access ${device}. Please check your device settings and try again.`);
            }
            return;
        }

        const remoteName = activeConv.is_group
            ? (activeConv.group_name || activeConv.name)
            : (activeConv.other_full_name || activeConv.other_username);
        const remoteAvatar = activeConv.is_group ? null : activeConv.other_avatar;

        setCallState({
            callId: null,
            conversationId: activeConv.id,
            callType,
            isIncoming: false,
            callerId: user.id,
            remoteName,
            remoteAvatar,
            isGroup: activeConv.is_group || false,
            accepted: false,
            acceptedBy: null,
            onSignal: callSignalRef,
            onEndExternal: callEndRef,
            localStream: stream
        });

        wsSend('call_initiate', {
            conversationId: activeConv.id,
            callType
        });
    };

    const handleVoiceCall = () => initiateCall('voice');
    const handleVideoCall = () => initiateCall('video');
    const handleEndCall = () => setCallState(null);

    return {
        handleVoiceCall, handleVideoCall, handleEndCall,
    };
}
