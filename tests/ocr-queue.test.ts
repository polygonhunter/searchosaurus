import { describe, expect, it } from "vitest";
import { OcrQueue, type Scheduler } from "../src/core/ocr-queue";

/** Runs scheduled work immediately — jobs still resolve as microtasks. */
const sync: Scheduler = (run) => run();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OcrQueue", () => {
	it("runs jobs serially in order", async () => {
		const queue = new OcrQueue(sync);
		const order: string[] = [];
		queue.push("a", async () => void order.push("a"));
		queue.push("b", async () => void order.push("b"));
		await tick();
		expect(order).toEqual(["a", "b"]);
	});

	it("runs high-priority jobs before queued low ones", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const queue = new OcrQueue(sync);
		const order: string[] = [];
		queue.push("blocker", async () => gate); // occupies the queue
		queue.push("low", async () => void order.push("low"), "low");
		queue.push("high", async () => void order.push("high"), "high");
		release();
		await tick();
		expect(order).toEqual(["high", "low"]);
	});

	it("dedupes by key", async () => {
		const queue = new OcrQueue(sync);
		let runs = 0;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		queue.push("blocker", async () => gate);
		queue.push("x", async () => void runs++);
		queue.push("x", async () => void runs++); // ignored
		release();
		await tick();
		expect(runs).toBe(1);
	});

	it("re-allows a key after its job finished", async () => {
		const queue = new OcrQueue(sync);
		let runs = 0;
		queue.push("x", async () => void runs++);
		await tick();
		queue.push("x", async () => void runs++);
		await tick();
		expect(runs).toBe(2);
	});

	it("drop removes a queued job", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const queue = new OcrQueue(sync);
		let ran = false;
		queue.push("blocker", async () => gate);
		queue.push("victim", async () => void (ran = true));
		queue.drop("victim");
		release();
		await tick();
		expect(ran).toBe(false);
	});

	it("pause holds jobs, resume runs them", async () => {
		const queue = new OcrQueue(sync);
		let ran = false;
		queue.pause();
		queue.push("x", async () => void (ran = true));
		await tick();
		expect(ran).toBe(false);
		queue.resume();
		await tick();
		expect(ran).toBe(true);
	});

	it("a throwing job does not stall the queue", async () => {
		const queue = new OcrQueue(sync);
		const order: string[] = [];
		queue.push("bad", async () => {
			order.push("bad");
			throw new Error("boom");
		});
		queue.push("good", async () => void order.push("good"));
		await tick();
		expect(order).toEqual(["bad", "good"]);
	});
});
