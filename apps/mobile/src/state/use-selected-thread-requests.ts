import { useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingUserInputs,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
  sortThreadActivities,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: UserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const respondingUserInputRequestKeysRef = useRef(new Set<string>());

  // Sort once; both derivations expect the same lifecycle ordering.
  const sortedActivities = useMemo(
    () => (selectedThread ? sortThreadActivities(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApprovals = useMemo(
    () => derivePendingApprovals(sortedActivities),
    [sortedActivities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = useMemo(
    () => derivePendingUserInputs(sortedActivities),
    [sortedActivities],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const submitUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: Record<string, string | ReadonlyArray<string>>,
    ) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      if (respondingUserInputRequestKeysRef.current.has(requestKey)) {
        return;
      }
      respondingUserInputRequestKeysRef.current.add(requestKey);
      setRespondingUserInputId(requestId);
      try {
        return await respondToUserInput({
          environmentId: selectedThreadShell.environmentId,
          input: {
            threadId: selectedThreadShell.id,
            requestId,
            answers,
          },
        });
      } finally {
        respondingUserInputRequestKeysRef.current.delete(requestKey);
        setRespondingUserInputId((current) => (current === requestId ? null : current));
      }
    },
    [respondToUserInput, selectedThreadShell],
  );

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, label: string) => {
      if (!selectedThreadShell || activePendingUserInput?.requestId !== requestId) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      if (respondingUserInputRequestKeysRef.current.has(requestKey)) {
        return;
      }
      const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
      const selection = selectPendingUserInputOption(
        activePendingUserInput.questions,
        current[requestKey] ?? {},
        question,
        label,
      );
      appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
        ...current,
        [requestKey]: selection.drafts,
      });
      if (selection.immediateAnswers) {
        void submitUserInput(requestId, selection.immediateAnswers);
      }
    },
    [activePendingUserInput, selectedThreadShell, submitUserInput],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    return submitUserInput(activePendingUserInput.requestId, activePendingUserInputAnswers);
  }, [activePendingUserInput, activePendingUserInputAnswers, selectedThreadShell, submitUserInput]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  };
}
