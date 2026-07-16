/**
 * Serial low-priority job queue for text extraction. Pure: the scheduler is
 * injected (production uses requestIdleCallback-with-fallback, tests run
 * synchronously). One job at a time — OCR is CPU-heavy, the UI thread and
 * the tesseract worker must never be flooded.
 */

export type Scheduler = (run: () => void) => void;

interface QueuedJob {
	key: string;
	run: () => Promise<void>;
}

export class OcrQueue {
	private readonly high: QueuedJob[] = [];
	private readonly low: QueuedJob[] = [];
	private readonly keys = new Set<string>();
	private running = false;
	private paused = false;

	constructor(private readonly schedule: Scheduler) {}

	get size(): number {
		return this.high.length + this.low.length + (this.running ? 1 : 0);
	}

	/** Enqueue once per key — re-pushing an in-flight/queued key is a no-op. */
	push(key: string, run: () => Promise<void>, priority: "high" | "low" = "low"): void {
		if (this.keys.has(key)) return;
		this.keys.add(key);
		(priority === "high" ? this.high : this.low).push({ key, run });
		this.pump();
	}

	/** Drop a queued job (e.g. its file was deleted). In-flight jobs finish. */
	drop(key: string): void {
		for (const list of [this.high, this.low]) {
			const index = list.findIndex((job) => job.key === key);
			if (index >= 0) {
				list.splice(index, 1);
				this.keys.delete(key);
				return;
			}
		}
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.pump();
	}

	clear(): void {
		this.high.length = 0;
		this.low.length = 0;
		this.keys.clear();
	}

	private pump(): void {
		if (this.running || this.paused) return;
		const job = this.high.shift() ?? this.low.shift();
		if (!job) return;
		this.running = true;
		this.schedule(() => {
			void job
				.run()
				.catch(() => undefined)
				.finally(() => {
					this.keys.delete(job.key);
					this.running = false;
					this.pump();
				});
		});
	}
}

/** Production scheduler: idle time when available, gentle timeout otherwise. */
export function idleScheduler(win: {
	requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
	setTimeout: (cb: () => void, ms: number) => number;
}): Scheduler {
	return (run) => {
		if (typeof win.requestIdleCallback === "function") {
			win.requestIdleCallback(run, { timeout: 4000 });
		} else {
			win.setTimeout(run, 200);
		}
	};
}
