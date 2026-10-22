export type EnqueueResult = { ok: true } | { ok: false; reason: "full" };

export class TaskQueue {
  private readonly ids: string[] = [];

  constructor(private readonly maxSize: number) {}

  enqueue(id: string): EnqueueResult {
    if (this.ids.includes(id)) return { ok: true };
    if (this.ids.length >= this.maxSize) return { ok: false, reason: "full" };
    this.ids.push(id);
    return { ok: true };
  }

  dequeue(): string | undefined {
    return this.ids.shift();
  }

  remove(id: string): boolean {
    const index = this.ids.indexOf(id);
    if (index === -1) return false;
    this.ids.splice(index, 1);
    return true;
  }

  position(id: string): number | null {
    const index = this.ids.indexOf(id);
    return index === -1 ? null : index + 1;
  }

  get size(): number {
    return this.ids.length;
  }

  snapshot(): readonly string[] {
    return [...this.ids];
  }
}
