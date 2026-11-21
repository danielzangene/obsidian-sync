import { Notice } from "obsidian";
import type { SyncProgress } from "../app/sync-report";
import { formatProgress } from "./report-text";

/**
 * Shows run progress: in the status bar on desktop, in a persistent notice on mobile, where
 * Obsidian has no status bar.
 */
export class ProgressIndicator {
  private notice: Notice | null = null;

  constructor(private readonly statusBarEl: HTMLElement | null) {}

  update(progress: SyncProgress): void {
    const text = formatProgress(progress);
    if (this.statusBarEl !== null) {
      this.statusBarEl.setText(text);
      return;
    }
    if (this.notice === null) this.notice = new Notice(text, 0);
    else this.notice.setMessage(text);
  }

  clear(): void {
    this.statusBarEl?.setText("");
    this.notice?.hide();
    this.notice = null;
  }
}
