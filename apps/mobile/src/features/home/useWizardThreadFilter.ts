import { useAtomValue } from "@effect/atom-react";
import {
  requiredThreadTagsAtom,
  WIZARD_THREAD_FILTER,
} from "@t3tools/client-runtime/state/threads";
import { useCallback } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import type { HomeListWizardFilter } from "./home-list-filter-menu";

/** The shared "only Wizard threads" filter the web sidebar's wand button also sets. */
export function useWizardThreadFilter(): HomeListWizardFilter {
  const offered = useAtomValue(environmentThreadShells.hasWizardThreadsAtom);
  const active = useAtomValue(requiredThreadTagsAtom) !== null;
  const onChange = useCallback((next: boolean) => {
    appAtomRegistry.set(requiredThreadTagsAtom, next ? WIZARD_THREAD_FILTER : null);
  }, []);
  return { offered, active, onChange };
}
