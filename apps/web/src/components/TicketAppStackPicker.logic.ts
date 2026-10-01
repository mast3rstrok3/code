import type { AppStackBundlePlan, AppStackShape } from "@t3tools/contracts";
import type { TicketAppStackSource } from "@t3tools/shared/appReviewParts";

export const TICKET_APP_STACK_SOURCE_LABELS: Record<TicketAppStackSource, string> = {
  override: "Your choice",
  plan: "Planned",
  default: "Default",
};

/** The apps a shape runs next to the ticket's own; "all" means every other planned app. */
export function bundledApps(
  shape: AppStackShape,
  plan: AppStackBundlePlan | null,
): ReadonlySet<string> {
  if (shape.bundle !== "all") return new Set(shape.bundle ?? []);
  return new Set(
    (plan?.members ?? []).flatMap((member) => (member.app === plan?.app ? [] : [member.app])),
  );
}

function shapeOf(
  bundle: AppStackShape["bundle"],
  omitServices: Readonly<Record<string, ReadonlyArray<string>>>,
): AppStackShape {
  const omitted = Object.fromEntries(
    Object.entries(omitServices).filter(([, services]) => services.length > 0),
  );
  return {
    ...(bundle === undefined || bundle.length === 0 ? {} : { bundle }),
    ...(Object.keys(omitted).length === 0 ? {} : { omitServices: omitted }),
  };
}

/**
 * The shape after bundling or unbundling one app. "all" turns into the list
 * it stood for, and an app that stops running drops its left-out services.
 */
export function setBundledApp(
  shape: AppStackShape,
  plan: AppStackBundlePlan,
  app: string,
  bundled: boolean,
): AppStackShape {
  const apps = new Set(bundledApps(shape, plan));
  if (bundled) apps.add(app);
  else apps.delete(app);
  const bundle = plan.members.flatMap((member) => (apps.has(member.app) ? [member.app] : []));
  const omitServices = Object.fromEntries(
    Object.entries(shape.omitServices ?? {}).filter(
      ([name]) => name === plan.app || apps.has(name),
    ),
  );
  return shapeOf(bundle, omitServices);
}

export function setServiceOmitted(
  shape: AppStackShape,
  app: string,
  service: string,
  omitted: boolean,
): AppStackShape {
  const services = new Set(shape.omitServices?.[app] ?? []);
  if (omitted) services.add(service);
  else services.delete(service);
  return shapeOf(shape.bundle, { ...shape.omitServices, [app]: [...services].sort() });
}
