/**
 * The options & metafields card's saves go through a module-scope queue
 * (app/services/editor/sub-resource-save-queue.ts), not through the hook's
 * fetcher. This harness replaces the queue's request function so a test can
 * read what was SENT and answer each request by hand, in any order.
 */
import { act } from "@testing-library/react";
import { __resetSaveQueueForTests, __setSavePosterForTests } from "~/services/editor/sub-resource-save-queue";

export function installSaves() {
  __resetSaveQueueForTests();
  /** Every request the queue sent, in order. */
  const sent: FormData[] = [];
  const waiting: Array<(answer: any) => void> = [];
  __setSavePosterForTests((fd: FormData) => {
    sent.push(fd);
    return new Promise((resolve) => waiting.push(resolve));
  });
  /** Let the chain start its next request / deliver an answer. */
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  };
  return {
    sent,
    waiting,
    flush,
    /** Answer the OLDEST request that has not been answered. */
    async settle(answer: any) {
      const resolve = waiting.shift();
      if (!resolve) throw new Error("no save request is waiting for an answer");
      await act(async () => {
        resolve(answer);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
    },
    /** The request fields as a plain object. */
    fields(index = sent.length - 1): Record<string, string> {
      const form = sent[index];
      return form ? (Object.fromEntries(form.entries()) as Record<string, string>) : {};
    },
  };
}
