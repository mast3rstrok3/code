import type { ApprovalRequestId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import type { WorkflowPendingQuestion } from "./workflowQuestions";

type Question = WorkflowPendingQuestion["questions"][number];

/** One open workflow question round, answered the way the web runtime panel answers it. */
export function WorkflowQuestionsCard(props: {
  readonly request: WorkflowPendingQuestion;
  readonly disabled: boolean;
  readonly onSubmit: (
    requestId: ApprovalRequestId,
    answers: Record<string, { readonly answers: readonly string[] }>,
  ) => Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const answered = (question: Question) =>
    (answers[question.id] ?? []).some((answer) => answer.trim().length > 0);
  const complete = props.request.questions.every(answered);

  const toggleOption = (question: Question, label: string) =>
    setAnswers((current) => {
      const selected = current[question.id] ?? [];
      if (!question.multiSelect) return { ...current, [question.id]: [label] };
      return {
        ...current,
        [question.id]: selected.includes(label)
          ? selected.filter((answer) => answer !== label)
          : [...selected, label],
      };
    });
  const setCustomAnswer = (question: Question, value: string) =>
    setAnswers((current) => {
      const optionLabels = new Set(question.options.map((option) => option.label));
      const kept = question.multiSelect
        ? (current[question.id] ?? []).filter((answer) => optionLabels.has(answer))
        : [];
      return { ...current, [question.id]: [...kept, ...(value ? [value] : [])] };
    });

  return (
    <View className="gap-4 rounded-2xl border border-border bg-grouped-card p-4">
      <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-warning-foreground">
        The workflow needs your answer
      </Text>
      {props.request.questions.map((question) => {
        const selected = answers[question.id] ?? [];
        const optionLabels = new Set(question.options.map((option) => option.label));
        const custom = question.multiSelect
          ? (selected.find((answer) => !optionLabels.has(answer)) ?? "")
          : optionLabels.has(selected[0] ?? "")
            ? ""
            : (selected[0] ?? "");
        return (
          <View key={question.id} className="gap-2">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted">
              {question.header}
            </Text>
            <Text className="text-sm leading-5 text-foreground">{question.question}</Text>
            {question.options.map((option) => {
              const checked = selected.includes(option.label);
              return (
                <Pressable
                  key={option.label}
                  accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                  accessibilityState={{ checked, disabled: props.disabled }}
                  disabled={props.disabled}
                  onPress={() => toggleOption(question, option.label)}
                  className={cn(
                    "min-h-12 w-full gap-0.5 rounded-2xl border px-3.5 py-3",
                    checked ? "border-primary bg-primary/10" : "border-border bg-input",
                  )}
                >
                  <Text
                    className={cn(
                      "font-t3-bold text-sm",
                      checked ? "text-foreground" : "text-foreground-secondary",
                    )}
                  >
                    {option.label}
                  </Text>
                  {option.description && option.description !== option.label ? (
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
            {question.allowCustomAnswer !== false ? (
              <TextInput
                accessibilityLabel={`${question.header}: your answer`}
                editable={!props.disabled}
                multiline
                placeholder="Your answer"
                value={custom}
                onChangeText={(value) => setCustomAnswer(question, value)}
                className="min-h-11 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
              />
            ) : null}
            {question.recommendation ? (
              <Text className="text-xs leading-4 text-foreground-muted">
                Recommended: {question.recommendation.optionLabel}.{" "}
                {question.recommendation.rationale}
              </Text>
            ) : null}
          </View>
        );
      })}
      <Button
        label="Submit answers"
        tone={complete ? "primary" : "secondary"}
        fullWidth
        loading={submitting}
        disabled={props.disabled || !complete}
        onPress={() => {
          setSubmitting(true);
          void props
            .onSubmit(
              props.request.requestId,
              Object.fromEntries(
                props.request.questions.map((question) => [
                  question.id,
                  {
                    answers: (answers[question.id] ?? []).filter(
                      (answer) => answer.trim().length > 0,
                    ),
                  },
                ]),
              ),
            )
            .finally(() => setSubmitting(false));
        }}
      />
    </View>
  );
}
