/**
 * Pausing a workflow marks the scope the user stopped, and every thread under
 * that scope is paused with it: the decider refuses to start server-driven
 * turns beneath one, and reactors must not try.
 *
 * The mark is its own field rather than a settle. A settle is an inbox state
 * that any real activity clears, and the agents a pause stops keep writing for
 * a while after the click, so a pause expressed as a settle un-does itself on
 * the next session heartbeat. That is exactly the bug this replaces.
 *
 * The walk lives in contracts because both sides read it: a reactor must never
 * queue work the decider will reject, and a client has to show the same pause
 * on the same scope.
 */
export {
  findWorkflowPauseScope,
  isWorkflowThreadPaused,
  type WorkflowPauseThread,
} from "@t3tools/contracts";
