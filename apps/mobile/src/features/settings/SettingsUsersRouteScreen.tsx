import * as Dialog from "../../components/ui/Dialog";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type GithubOwnerTokenVerification,
  type WorkspaceUser,
  type WorkspaceUserId,
} from "@t3tools/contracts";
import {
  addWorkspaceUserGithubOwnerToken,
  clearWorkspaceUserGithubPersonalAccessToken,
  createWorkspaceUser,
  githubFineGrainedTokenUrl,
  githubOwnerTokenValidationMessage,
  removeWorkspaceUserGithubOwnerToken,
  renameWorkspaceUser,
  replaceWorkspaceUserGithubOwnerToken,
  validateAddGithubOwnerToken,
  validateAddWorkspaceUser,
  validateRenameWorkspaceUser,
  workspaceUserDisplayNameMessage,
  workspaceUserGithubTokenCount,
} from "@t3tools/shared/workspaceUserSettings";
import { useRef, useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceUsers } from "../../state/workspace-users";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

const USERS_INTRO =
  "Choose your user in the thread list filter before starting a thread. Each thread keeps its owner when you switch users or view someone else's threads. Every user, including the main user, needs a name and a valid GitHub token before running an agent. Commits use the name entered here. Pushes and pull requests use that user's token.";

const TOKENS_FOOTER =
  "A fine-grained token covers one GitHub user or organization, so add one per owner. Threads use the token whose owner matches the project's GitHub remote.";

const TOKEN_PERMISSIONS_HELP =
  "The link selects Contents, Pull requests, and Workflows (read and write) and Commit statuses and Actions (read). Choose the repositories yourself, since GitHub cannot pre-select them. Add Issues if agents work with issues.";

function tokenCountLabel(user: WorkspaceUser): string {
  const count = workspaceUserGithubTokenCount(user);
  if (count === 0) return "No GitHub token";
  return `${count} GitHub ${count === 1 ? "token" : "tokens"}`;
}

function useSettingsUserNavigation() {
  const navigation = useNavigation();
  return {
    openUser: (params: {
      readonly environmentId: EnvironmentId;
      readonly userId: WorkspaceUserId;
    }) =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsUser", params },
      }),
    openToken: (params: {
      readonly environmentId: EnvironmentId;
      readonly userId: WorkspaceUserId;
      readonly owner?: string;
    }) =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsUserGithubToken", params },
      }),
  };
}

/** Saves the whole user list, as the web does. Resolves false when the server rejected it. */
function useSaveWorkspaceUsers(environmentId: EnvironmentId) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "workspace users update",
    reportFailure: false,
  });
  return async (users: ReadonlyArray<WorkspaceUser> | null): Promise<boolean> => {
    if (users === null) return false;
    const result = await updateSettings({
      environmentId,
      input: { patch: { workspaceUsers: [...users] } },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not save users",
        error instanceof Error ? error.message : "The server did not accept the change.",
      );
    }
    return false;
  };
}

/** Asks the server to check an owner token with GitHub before it is saved. */
function useVerifyGithubOwnerToken(environmentId: EnvironmentId) {
  const verify = useAtomCommand(serverEnvironment.verifyGithubOwnerToken, {
    reportFailure: false,
  });
  return async (owner: string, personalAccessToken: string) => {
    const result = await verify({ environmentId, input: { owner, personalAccessToken } });
    return result._tag === "Success"
      ? result.value
      : ({
          valid: false,
          message: "Could not check the token. Try again.",
        } satisfies GithubOwnerTokenVerification);
  };
}

export function SettingsUsersRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Users" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            <>
              <Text textRole="footnote" className="px-2 text-foreground-muted android:px-4">
                {USERS_INTRO}
              </Text>
              {selectedTargets.map((target) => (
                <EnvironmentUsersSection
                  key={target.environmentId}
                  target={target}
                  title={selectedTargets.length === 1 ? "Users" : target.label}
                  canWrite={writableEnvironments.has(target.environmentId)}
                />
              ))}
            </>
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentUsersSection(props: {
  readonly target: SettingsTarget;
  readonly title: string;
  readonly canWrite: boolean;
}) {
  const { openUser } = useSettingsUserNavigation();
  const environmentId = props.target.environmentId;
  const users = useWorkspaceUsers(environmentId);
  const save = useSaveWorkspaceUsers(environmentId);
  const [saving, setSaving] = useState(false);

  const promptAddUser = () => {
    if (users === null) return;
    Dialog.prompt({
      title: "Add user",
      message: "Commits use this name.",
      placeholder: "Display name",
      initialValue: "",
      confirmText: "Add",
      onConfirm: (displayName) => {
        const message = workspaceUserDisplayNameMessage(
          validateAddWorkspaceUser(displayName, users),
        );
        const user = createWorkspaceUser(displayName, users);
        if (!user) {
          if (message) Dialog.alert("Could not add user", message);
          return;
        }
        setSaving(true);
        void save([...users, user]).finally(() => setSaving(false));
      },
    });
  };

  return (
    <SettingsSection
      title={props.title}
      footer={
        props.canWrite
          ? undefined
          : `This session can view ${props.target.label}'s users but can't change them.`
      }
    >
      {users === null ? (
        <Text className="p-4 text-foreground-muted">Loading users…</Text>
      ) : (
        users.map((user, index) => (
          <View key={user.id} className={index === 0 ? undefined : "border-t border-border-subtle"}>
            <ListRow
              icon="person.crop.circle"
              label={user.displayName}
              description={tokenCountLabel(user)}
              onPress={() => openUser({ environmentId, userId: user.id })}
            />
          </View>
        ))
      )}
      <View className="border-t border-border-subtle">
        <SettingsActionRow
          icon="person.badge.plus"
          label="Add user"
          loading={saving}
          disabled={!props.canWrite || users === null}
          onPress={promptAddUser}
        />
      </View>
    </SettingsSection>
  );
}

export function SettingsUserRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly userId: WorkspaceUserId;
}>) {
  const insets = useSafeAreaInsets();
  const { openToken } = useSettingsUserNavigation();
  const { environmentId, userId } = route.params;
  const users = useWorkspaceUsers(environmentId);
  const user = users?.find((candidate) => candidate.id === userId) ?? null;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const save = useSaveWorkspaceUsers(environmentId);
  const [pending, setPending] = useState<"rename" | "legacy" | null>(null);

  const promptRename = () => {
    if (!users || !user) return;
    Dialog.prompt({
      title: "Rename user",
      message: "Commits use this name.",
      placeholder: "Display name",
      initialValue: user.displayName,
      confirmText: "Rename",
      onConfirm: (displayName) => {
        const message = workspaceUserDisplayNameMessage(
          validateRenameWorkspaceUser({ user, displayName, workspaceUsers: users }),
        );
        const nextUsers = renameWorkspaceUser(users, user.id, displayName);
        if (!nextUsers) {
          if (message) Dialog.alert("Could not rename user", message);
          return;
        }
        setPending("rename");
        void save(nextUsers).finally(() => setPending(null));
      },
    });
  };

  const confirmRemoveLegacyToken = () => {
    if (!users || !user) return;
    Dialog.confirm({
      title: "Remove older token?",
      message:
        "Repositories without an owner token will have no GitHub token. Add it again under its owner first.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        setPending("legacy");
        void save(clearWorkspaceUserGithubPersonalAccessToken(users, user.id)).finally(() =>
          setPending(null),
        );
      },
    });
  };

  const ownerTokens = user?.github.ownerTokens ?? [];
  const disabled = !canWrite || pending !== null;

  return (
    <SettingsScreen title={user?.displayName ?? "User"}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {user === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            {users === null ? "Loading user…" : "This user no longer exists on the server."}
          </Text>
        ) : (
          <>
            {workspaceUserGithubTokenCount(user) === 0 ? (
              <Notice
                tone="danger"
                icon="exclamationmark.triangle"
                message={`${user.displayName} has no GitHub token. Threads they own can't push or open pull requests until one is added.`}
              />
            ) : null}
            <SettingsSection title="Name" footer={`Stable user id ${user.id}`}>
              <SettingsActionRow
                icon="pencil"
                label={user.displayName}
                description="Rename"
                loading={pending === "rename"}
                disabled={disabled}
                onPress={promptRename}
              />
            </SettingsSection>
            <SettingsSection title="GitHub tokens" footer={TOKENS_FOOTER}>
              {ownerTokens.map((token, index) => (
                <View
                  key={token.owner}
                  className={index === 0 ? undefined : "border-t border-border-subtle"}
                >
                  <ListRow
                    icon="checkmark.circle"
                    label={token.owner}
                    description={canWrite ? "Replace or remove" : undefined}
                    disabled={!canWrite}
                    onPress={() => openToken({ environmentId, userId, owner: token.owner })}
                  />
                </View>
              ))}
              {user.github.personalAccessTokenRedacted ? (
                <View
                  className={ownerTokens.length === 0 ? undefined : "border-t border-border-subtle"}
                >
                  <SettingsActionRow
                    icon="trash"
                    tone="danger"
                    label="Older token without an owner"
                    description="Used for repositories no owner token covers. Add it again under its owner, then remove it here."
                    loading={pending === "legacy"}
                    disabled={disabled}
                    onPress={confirmRemoveLegacyToken}
                  />
                </View>
              ) : null}
              <View
                className={
                  ownerTokens.length === 0 && !user.github.personalAccessTokenRedacted
                    ? undefined
                    : "border-t border-border-subtle"
                }
              >
                <SettingsActionRow
                  icon="plus"
                  label="Add token"
                  disabled={disabled}
                  onPress={() => openToken({ environmentId, userId })}
                />
              </View>
            </SettingsSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SettingsUserGithubTokenRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly userId: WorkspaceUserId;
  /** Present when replacing that owner's token. */
  readonly owner?: string;
}>) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { environmentId, userId } = route.params;
  const replacingOwner = route.params.owner ?? null;
  const users = useWorkspaceUsers(environmentId);
  const user = users?.find((candidate) => candidate.id === userId) ?? null;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const save = useSaveWorkspaceUsers(environmentId);
  const verifyToken = useVerifyGithubOwnerToken(environmentId);
  const [ownerDraft, setOwnerDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const pendingRef = useRef(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  const owner = replacingOwner ?? ownerDraft;
  const trimmedToken = tokenDraft.trim();
  const addValidation = user ? validateAddGithubOwnerToken(user, ownerDraft, tokenDraft) : null;
  const message =
    (replacingOwner === null && addValidation
      ? githubOwnerTokenValidationMessage(addValidation)
      : null) ?? verificationError;
  const canSubmit =
    canWrite &&
    pending === null &&
    user !== null &&
    (replacingOwner === null ? addValidation?.valid === true : trimmedToken.length > 0);

  const submit = async () => {
    if (!canSubmit || !users || !user || pendingRef.current) return;
    pendingRef.current = true;
    setPending("save");
    const candidateOwner = owner.trim();
    const verification = await verifyToken(candidateOwner, trimmedToken);
    if (!verification.valid) {
      pendingRef.current = false;
      setPending(null);
      setVerificationError(verification.message);
      return;
    }
    const nextUsers =
      replacingOwner === null
        ? addWorkspaceUserGithubOwnerToken(users, user.id, verification.owner, trimmedToken)
        : replaceWorkspaceUserGithubOwnerToken(users, user.id, replacingOwner, trimmedToken);
    const saved = await save(nextUsers);
    pendingRef.current = false;
    setPending(null);
    if (saved) navigation.goBack();
  };

  const confirmRemove = () => {
    if (!users || !user || replacingOwner === null) return;
    Dialog.confirm({
      title: `Remove token for ${replacingOwner}?`,
      message: `${user.displayName}'s threads can't push to ${replacingOwner} repositories until a new token is added.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPending("remove");
        void save(removeWorkspaceUserGithubOwnerToken(users, user.id, replacingOwner)).then(
          (saved) => {
            pendingRef.current = false;
            setPending(null);
            if (saved) navigation.goBack();
          },
        );
      },
    });
  };

  const linkOwner =
    replacingOwner ??
    (addValidation?.valid || addValidation?.reason === "blank-token" ? ownerDraft.trim() : null);

  return (
    <SettingsScreen title={replacingOwner === null ? "Add GitHub token" : replacingOwner}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {user === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            {users === null ? "Loading user…" : "This user no longer exists on the server."}
          </Text>
        ) : (
          <>
            <SettingsSection title={user.displayName}>
              {replacingOwner === null ? (
                <TokenField
                  label="GitHub user or organization"
                  value={ownerDraft}
                  editable={pending === null}
                  onChangeText={(value) => {
                    setOwnerDraft(value);
                    setVerificationError(null);
                  }}
                />
              ) : null}
              <View
                className={replacingOwner === null ? "border-t border-border-subtle" : undefined}
              >
                <TokenField
                  label={replacingOwner === null ? "Token for its repositories" : "New token"}
                  value={tokenDraft}
                  secure
                  editable={pending === null}
                  onChangeText={(value) => {
                    setTokenDraft(value);
                    setVerificationError(null);
                  }}
                />
              </View>
            </SettingsSection>
            {message ? (
              <Notice tone="danger" icon="exclamationmark.circle" message={message} />
            ) : null}
            <Button
              label={
                pending === "save"
                  ? "Checking…"
                  : replacingOwner === null
                    ? "Add token"
                    : "Replace token"
              }
              tone="primary"
              fullWidth
              loading={pending === "save"}
              disabled={!canSubmit}
              onPress={() => void submit()}
            />
            <SettingsSection footer={TOKEN_PERMISSIONS_HELP}>
              <SettingsActionRow
                icon="safari"
                label={
                  linkOwner
                    ? `Create a fine-grained token for ${linkOwner}`
                    : "Create a fine-grained token for your account"
                }
                onPress={() =>
                  void Linking.openURL(githubFineGrainedTokenUrl(linkOwner ?? undefined))
                }
              />
            </SettingsSection>
            {replacingOwner !== null ? (
              <SettingsSection>
                <SettingsActionRow
                  icon="trash"
                  tone="danger"
                  label="Remove token"
                  loading={pending === "remove"}
                  disabled={!canWrite || pending !== null}
                  onPress={confirmRemove}
                />
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function TokenField(props: {
  readonly label: string;
  readonly value: string;
  readonly secure?: boolean;
  readonly editable: boolean;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        editable={props.editable}
        onChangeText={props.onChangeText}
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType={props.secure ? "password" : "none"}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}
