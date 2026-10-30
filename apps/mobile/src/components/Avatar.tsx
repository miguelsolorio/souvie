import { getAvatarUrl, useSupabase } from "@mp/db";
import { useQuery } from "@tanstack/react-query";
import { Image, Text, View } from "react-native";
import { initialsOf } from "../lib/initials";

/**
 * A round avatar. `path` is the object path in the private avatars bucket, turned into a
 * short-lived signed URL. With no picture it shows initials. Signed URLs are never persisted:
 * the query does not set `meta.persist`.
 */
export function Avatar({
  path,
  name,
  size = 48,
}: {
  path?: string | null;
  name?: string | null;
  size?: number;
}) {
  const client = useSupabase();
  const { data: url } = useQuery({
    queryKey: ["avatar-url", path],
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
    queryFn: () => getAvatarUrl(client, path, 3600),
  });

  const dimension = { width: size, height: size, borderRadius: size / 2 };
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={dimension}
        accessibilityLabel={name ? `${name}'s picture` : "Profile picture"}
      />
    );
  }
  return (
    <View
      style={dimension}
      className="items-center justify-center bg-brand/15"
      accessibilityLabel={name ? `${name}'s initials` : "No profile picture"}
    >
      <Text className="font-semibold text-brand" style={{ fontSize: size * 0.4 }}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}
