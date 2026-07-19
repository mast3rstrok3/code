export function getThreadDeleteConfirmationMessage(title: string): string {
  return `“${title}” and all sub-threads will be permanently deleted, including their terminal history.`;
}
