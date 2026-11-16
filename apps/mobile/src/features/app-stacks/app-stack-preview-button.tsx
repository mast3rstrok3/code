import type { AppStackStatus } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { APP_STACK_TONE_DOT_CLASS, appStackTone } from "./appStackPresentation";

/** The thread's App Stack in the floating control, beside the device and browser previews. */
export function AppStackPreviewButton(props: {
  readonly status: AppStackStatus;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? true;
  const dot = cn("size-2 rounded-full", APP_STACK_TONE_DOT_CLASS[appStackTone(props.status)]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`App Stack ${props.status}`}
      accessibilityHint="Opens this thread's App Stack"
      onPress={props.onPress}
      className={
        compact
          ? "size-11 shrink-0 items-center justify-center rounded-full active:bg-subtle"
          : "h-11 shrink-0 flex-row items-center justify-center gap-2 rounded-full px-4 active:bg-subtle"
      }
    >
      <SymbolView name="server.rack" size={20} tintColorClassName="accent-icon" type="monochrome" />
      {compact ? (
        <View className={cn("absolute right-2 top-2", dot)} />
      ) : (
        <>
          <View className={dot} />
          <AppText className="font-t3-medium text-xs text-foreground">
            App Stack {props.status}
          </AppText>
        </>
      )}
    </Pressable>
  );
}
