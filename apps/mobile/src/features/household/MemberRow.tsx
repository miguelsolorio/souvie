import type { HouseholdRosterEntry } from "@mp/core";
import { Text, View } from "react-native";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";

export function MemberRow({
  member,
  isSelf,
  canRemove,
  removing,
  onRemove,
}: {
  member: HouseholdRosterEntry;
  isSelf: boolean;
  canRemove: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const name = member.display_name?.trim() || (isSelf ? "You" : "Household member");
  return (
    <View testID={`member-${member.user_id}`} className="flex-row items-center gap-3">
      <Avatar path={member.avatar_url} name={member.display_name} size={44} />
      <View className="flex-1">
        <Text className="text-base font-medium text-neutral-900">
          {name}
          {isSelf && member.display_name ? " (you)" : ""}
        </Text>
        <Text className="text-sm text-neutral-500">
          {member.role === "owner" ? "Owner" : "Member"}
        </Text>
      </View>
      {canRemove ? (
        <View>
          <Button label="Remove" variant="danger" loading={removing} onPress={onRemove} />
        </View>
      ) : null}
    </View>
  );
}
