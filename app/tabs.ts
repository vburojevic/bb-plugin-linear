/**
 * The issue tab, as `experimental_panel.openTab` and
 * `experimental_useAppPanel().openTab` name it. The id is the retired
 * `threadPanelAction`'s, so tabs saved before the move still restore.
 */
export const ISSUE_TAB = { id: "issue", context: { kind: "thread" }, availability: "action" } as const;
