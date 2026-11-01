import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { ScreenStack } from "react-native-screens";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export interface AppStackHeaderAction {
  readonly id: string;
  readonly accessibilityLabel: string;
  readonly icon: Extract<AppSymbolName, string>;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

/**
 * The App Stack sheets share the thread sheets' chrome: a formSheet never
 * renders a stack header on iOS, so the header comes from a nested native
 * stack inside the sheet; Android embeds its sheet header.
 */
export function AppStackSheetFrame(props: {
  readonly screenId: string;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AppStackHeaderAction>;
  readonly children: ReactNode;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const actions = props.actions ?? [];

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
            <NativeInspectorContent>{props.children}</NativeInspectorContent>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={props.title}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
              headerRightBarButtonItems={
                actions.length > 0
                  ? actions.map((action) => ({
                      type: "button" as const,
                      accessibilityLabel: action.accessibilityLabel,
                      icon: { name: action.icon, type: "sfSymbol" as const },
                      identifier: `${props.screenId}-${action.id}`,
                      disabled: action.disabled,
                      onPress: action.onPress,
                    }))
                  : undefined
              }
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader
        title={props.title}
        subtitle={props.subtitle}
        onBack={() => navigation.goBack()}
        actions={actions}
      />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{props.children}</ScreenContent>
    </View>
  );
}
