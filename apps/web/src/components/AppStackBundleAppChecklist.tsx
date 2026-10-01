import type { AppStackBundlePlan, AppStackBundlePlanMember } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Checkbox } from "./ui/checkbox";

interface MemberState {
  readonly own: boolean;
  readonly selected: boolean;
}

/**
 * The platform apps a stack can bundle. The worktree's own app is always
 * checked; checked apps run from their worktrees on the branch, the rest stay
 * on their standing dev copies.
 */
export function AppStackBundleAppChecklist(props: {
  readonly plan: AppStackBundlePlan;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: ((app: string, checked: boolean) => void) | undefined;
  readonly describe: (member: AppStackBundlePlanMember, state: MemberState) => string;
  readonly renderDetails?: (member: AppStackBundlePlanMember, state: MemberState) => ReactNode;
}) {
  return (
    <>
      {props.plan.members.map((member) => {
        const own = member.app === props.plan.app;
        const state = { own, selected: own || props.selected.has(member.app) };
        return (
          <div key={member.app}>
            <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-md px-1 py-1 text-xs hover:bg-accent/50">
              <Checkbox
                checked={state.selected}
                disabled={own || props.onToggle === undefined}
                onCheckedChange={(checked) => props.onToggle?.(member.app, checked)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block font-medium">{member.app}</span>
                <span className="block truncate text-muted-foreground">
                  {props.describe(member, state)}
                </span>
              </span>
            </label>
            {props.renderDetails?.(member, state)}
          </div>
        );
      })}
    </>
  );
}
