import { useMemo } from "react";
import { Image, StyleSheet, View } from "react-native";
import ChatAvatar from "./ChatAvatar";
import { uploadUrl } from "../config";

type Props = {
  name?: string | null;
  avatar?: string | null;
  memberAvatars?: Array<string | null | undefined> | null;
  size?: number;
};

export default function GroupCompositeAvatar({
  name,
  avatar,
  memberAvatars,
  size = 48,
}: Props) {
  // NOTE: every hook must run BEFORE any early return. This `useMemo` used to
  // sit after the `if (avatar)` bail-out, so the hook count changed between
  // renders whenever `avatar` flipped between set and unset (e.g. right after
  // a group avatar upload, or when the list re-renders with a partial record).
  // React matches hooks positionally, so that mismatch throws
  // "Rendered fewer hooks than expected" and unmounts the tree — which, with
  // no error boundary previously in place, blanked the whole screen.
  const tiles = useMemo(
    () =>
      Array.from(
        new Set(
          (memberAvatars || [])
            .map((v) => (v ? uploadUrl(v) : null))
            .filter((v): v is string => !!v),
        ),
      ).slice(0, 4),
    [memberAvatars],
  );

  // An explicit group avatar always wins over the composite.
  if (avatar) {
    return <ChatAvatar name={name} avatar={avatar} size={size} />;
  }

  if (tiles.length === 0) {
    return <ChatAvatar name={name} size={size} />;
  }

  if (tiles.length === 1) {
    return <ChatAvatar name={name} avatar={tiles[0]} size={size} />;
  }

  const radius = size / 2;
  const half = Math.ceil(size / 2);

  return (
    <View
      style={[
        styles.wrap,
        { width: size, height: size, borderRadius: radius, overflow: "hidden" },
      ]}
    >
      {tiles.length === 2 ? (
        <>
          <Image source={{ uri: tiles[0] }} style={{ width: half, height: size }} />
          <Image source={{ uri: tiles[1] }} style={{ width: half, height: size }} />
        </>
      ) : (
        <>
          <Image source={{ uri: tiles[0] }} style={{ width: half, height: half }} />
          <Image source={{ uri: tiles[1] }} style={{ width: size - half, height: half }} />
          <Image source={{ uri: tiles[2] }} style={{ width: half, height: size - half }} />
          <Image
            source={{ uri: tiles[3] || tiles[0] }}
            style={{ width: size - half, height: size - half }}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: "#111827",
  },
});

