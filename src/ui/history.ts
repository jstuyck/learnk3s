// Command history with readline-style navigation and reverse search (Ctrl+R).
export class CommandHistory {
  entries: string[];
  private idx: number;
  private draft = '';

  constructor(entries: string[] = [], private readonly max = 100) {
    this.entries = entries.slice(-max);
    this.idx = this.entries.length;
  }

  push(line: string): void {
    if (this.entries[this.entries.length - 1] !== line) this.entries.push(line);
    this.entries = this.entries.slice(-this.max);
    this.idx = this.entries.length;
  }

  /** Up arrow. `current` is what is in the input right now. */
  prev(current: string): string {
    if (!this.entries.length) return current;
    if (this.idx === this.entries.length) this.draft = current;
    this.idx = Math.max(0, this.idx - 1);
    return this.entries[this.idx];
  }

  /** Down arrow. */
  next(current: string): string {
    if (this.idx >= this.entries.length) return current;
    this.idx++;
    return this.idx === this.entries.length ? this.draft : this.entries[this.idx];
  }

  resetCursor(): void { this.idx = this.entries.length; }

  /** Newest entry at or before `from` that contains `query`, or -1. */
  search(query: string, from: number = this.entries.length - 1): number {
    for (let i = Math.min(from, this.entries.length - 1); i >= 0; i--) {
      if (this.entries[i].includes(query)) return i;
    }
    return -1;
  }
}
