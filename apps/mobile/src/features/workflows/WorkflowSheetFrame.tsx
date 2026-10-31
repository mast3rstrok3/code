import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { ScreenStack } from "react-native-screens";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

/**
 * The form-sheet chrome the thread sheets share. A plain iOS formSheet never
 * renders a stack header, so the title comes from a nested native stack, the
 * same shape as the Agents sheet.
 */
export function WorkflowSheetFrame(props: {
  readonly screenId: string;
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId={props.screenId}
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {props.children}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={props.title}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={props.title} onBack={props.onBack} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{props.children}</ScreenContent>
    </View>
  );
}
