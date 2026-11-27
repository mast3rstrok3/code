import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

export function getThreadDeleteConfirmationMessage(title: string): string {
  return m(
    msg(
      "“{title}” and all sub-threads will be permanently deleted, including their terminal history.",
      { title },
    ),
  );
}
