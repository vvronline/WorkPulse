import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Mic,
  MicOff,
  PhoneOff,
  SwitchCamera,
  Video as VideoIcon,
  VideoOff,
  Volume1,
  Volume2,
} from "../../icons";
import type { LucideIcon } from "../../icons";
import { useTheme } from '../../theme/ThemeProvider';
import type { Theme } from '../../theme';
import { useResponsive } from '../../utils/responsive';

export type CallControlsProps = {
  isMuted: boolean;
  isVideoEnabled: boolean;
  isSpeakerOn: boolean;
  isVideoCall: boolean;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onToggleSpeaker: () => void;
  onSwitchCamera?: () => void;
  onEndCall: () => void;
};

export function CallControls({
  isMuted,
  isVideoEnabled,
  isSpeakerOn,
  isVideoCall,
  onToggleMute,
  onToggleVideo,
  onToggleSpeaker,
  onSwitchCamera,
  onEndCall,
}: CallControlsProps) {
  const theme = useTheme();
  const { scale, isSmall } = useResponsive();

  // Scale the control sizes down on small devices so the row never overflows.
  const buttonSize = scale(isSmall ? 52 : 56);
  const endCallSize = scale(isSmall ? 60 : 64);
  const iconSize = scale(isSmall ? 22 : 24);
  const endIconSize = scale(isSmall ? 26 : 28);
  const rowGap = scale(isSmall ? 12 : 18);

  const styles = useMemo(
    () => makeStyles({ buttonSize, endCallSize, rowGap }),
    [buttonSize, endCallSize, rowGap],
  );

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <ControlButton
          Icon={isMuted ? MicOff : Mic}
          label={isMuted ? 'Unmute' : 'Mute'}
          active={isMuted}
          onPress={onToggleMute}
          theme={theme}
          buttonSize={buttonSize}
          iconSize={iconSize}
        />
        {isVideoCall && (
          <ControlButton
            Icon={isVideoEnabled ? VideoIcon : VideoOff}
            label={isVideoEnabled ? 'Stop Video' : 'Start Video'}
            active={!isVideoEnabled}
            onPress={onToggleVideo}
            theme={theme}
            buttonSize={buttonSize}
            iconSize={iconSize}
          />
        )}
        <ControlButton
          Icon={isSpeakerOn ? Volume2 : Volume1}
          label="Speaker"
          active={isSpeakerOn}
          onPress={onToggleSpeaker}
          theme={theme}
          buttonSize={buttonSize}
          iconSize={iconSize}
        />
        {isVideoCall && onSwitchCamera && (
          <ControlButton
            Icon={SwitchCamera}
            label="Flip"
            onPress={onSwitchCamera}
            theme={theme}
            buttonSize={buttonSize}
            iconSize={iconSize}
          />
        )}
      </View>

      <Pressable
        style={[
          styles.endCallButton,
          {
            backgroundColor: theme.danger,
            width: endCallSize,
            height: endCallSize,
            borderRadius: endCallSize / 2,
          },
        ]}
        onPress={onEndCall}
        hitSlop={8}
      >
        <PhoneOff size={endIconSize} color="#fff" />
      </Pressable>
    </View>
  );
}

function ControlButton({
  Icon,
  label,
  active,
  onPress,
  theme,
  buttonSize,
  iconSize,
}: {
  Icon: LucideIcon;
  label: string;
  active?: boolean;
  onPress: () => void;
  theme: Theme;
  buttonSize: number;
  iconSize: number;
}) {
  return (
    <Pressable
      style={[styles.controlButton, { width: buttonSize + 24 }]}
      onPress={onPress}
      hitSlop={6}
    >
      <View
        style={[
          styles.controlButtonInner,
          {
            width: buttonSize,
            height: buttonSize,
            borderRadius: buttonSize / 2,
            backgroundColor: active ? theme.primary : theme.bgElevated,
          },
        ]}
      >
        <Icon size={iconSize} color={active ? '#fff' : theme.text} />
      </View>
      <Text
        style={[styles.controlLabel, { color: theme.textSecondary }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  controlButton: {
    alignItems: 'center',
    gap: 6,
  },
  controlButtonInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlLabel: {
    fontSize: 12,
  },
  endCallIcon: {
    transform: [{ rotate: '135deg' }],
  },
});

function makeStyles({
  rowGap,
}: {
  buttonSize: number;
  endCallSize: number;
  rowGap: number;
}) {
  return StyleSheet.create({
    container: {
      alignItems: 'center',
      gap: 20,
      width: '100%',
    },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      alignItems: 'center',
      columnGap: rowGap,
      rowGap: 16,
      maxWidth: '100%',
    },
    endCallButton: {
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}