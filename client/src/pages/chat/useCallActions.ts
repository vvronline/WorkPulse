import { createMeeting } from "../../api";
import type useChatState from "./useChatState";

type ChatState = ReturnType<typeof useChatState>;

export default function useCallActions(state: ChatState) {
    const { user, wsSend, activeConv, setCallState, callSignalRef, callEndRef } =
        state;

    async function startGroupMeeting() {
        if (!activeConv) return;
        const groupName =
            (activeConv.group_name as string) ||
            (activeConv.name as string) ||
            "Group call";
        try {
            const { data } = await createMeeting({
                title: groupName,
                conversation_id: activeConv.id,
                settings: { allowScreenShare: true },
            });
            const code = (data as { meeting_code?: string }).meeting_code;
            if (code) {
                window.location.assign(`/meeting/${code}`);
            } else {
                alert("Could not start the group call. Please try again.");
            }
        } catch (err) {
            console.error("Failed to start group meeting:", err);
            alert("Could not start the group call. Please try again.");
        }
    }

    const initiateCall = (callType: string) => {
        if (!activeConv) return;
        if (activeConv.is_group) {
            void startGroupMeeting();
            return;
        }

        const remoteName = activeConv.is_group
            ? (activeConv.group_name as string) || (activeConv.name as string)
            : (activeConv.other_full_name as string) ||
              (activeConv.other_username as string);
        const remoteAvatar = activeConv.is_group
            ? null
            : (activeConv.other_avatar as string | null);

        setCallState({
            callId: undefined,
            conversationId: activeConv.id,
            callType,
            isIncoming: false,
            callerId: user?.id,
            remoteName,
            remoteAvatar,
            isGroup: (activeConv.is_group as boolean) || false,
            accepted: false,
            acceptedBy: null,
            onSignal: callSignalRef as React.MutableRefObject<unknown>,
            onEndExternal: callEndRef as React.MutableRefObject<unknown>,
            localStream: null,
        });

        wsSend("call_initiate", {
            conversationId: activeConv.id,
            callType,
        });

        const isMobile = /Android|iPhone|iPad|iPod/i.test(
            navigator.userAgent,
        );
        const videoConstraints = isMobile
            ? {
                  width: { ideal: 640 },
                  height: { ideal: 480 },
                  frameRate: { ideal: 24 },
                  facingMode: "user",
              }
            : {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  facingMode: "user",
              };

        navigator.mediaDevices
            .getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: callType === "video" ? videoConstraints : false,
            })
            .then((stream) => {
                setCallState((prev) =>
                    prev ? { ...prev, localStream: stream } : prev,
                );
            })
            .catch((err) => {
                console.error("Failed to get media:", err);
                const device =
                    callType === "video" ? "camera/microphone" : "microphone";
                if (err?.name === "NotAllowedError") {
                    alert(
                        `${device} access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow ${device}\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site`,
                    );
                } else if (err?.name === "NotFoundError") {
                    alert(
                        `No ${device} found. Please connect a ${device} and try again.`,
                    );
                } else {
                    alert(
                        `Could not access ${device}. Please check your device settings and try again.`,
                    );
                }
                wsSend("call_cancel", { conversationId: activeConv.id });
                setCallState(null);
            });
    };

    const handleVoiceCall = () => initiateCall("voice");
    const handleVideoCall = () => initiateCall("video");
    const handleEndCall = () => setCallState(null);

    return {
        handleVoiceCall,
        handleVideoCall,
        handleEndCall,
    };
}