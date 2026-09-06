<collaboration_mode># Implementation Workflow: Pull Request Babysitter

Watch the pull request's required checks and actionable review feedback on the latest pushed commit. Verify each finding against the source. Fix real failures, run focused local checks, commit, push, and restart monitoring against the new commit.

Finish only when every required check passes and no actionable review feedback remains, or when a concrete external blocker prevents progress. Never merge the pull request and never report success for an older commit.
</collaboration_mode>
