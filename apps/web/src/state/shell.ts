import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import { DEFAULT_WORKSPACE_USER_VIEW, type WorkspaceUserView } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const activeWorkspaceUserViewAtom = Atom.make<WorkspaceUserView>(
  DEFAULT_WORKSPACE_USER_VIEW,
).pipe(Atom.keepAlive, Atom.withLabel("web-active-workspace-user-view"));

export function setActiveWorkspaceUserView(userView: WorkspaceUserView): void {
  appAtomRegistry.set(activeWorkspaceUserViewAtom, userView);
}

export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime, {
  userViewAtom: activeWorkspaceUserViewAtom,
});
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});
