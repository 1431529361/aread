import { describe, expect, it } from 'vitest';
import {
  TaskCancelledError,
  runDag,
  type DagEvent,
  type DagNode,
} from '../src/core/orchestrator/dag';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runDag', () => {
  it('按依赖顺序执行并保存输出', async () => {
    const order: string[] = [];
    const nodes: DagNode[] = [
      {
        id: 'b',
        deps: ['a'],
        async run(context) {
          order.push('b');
          return `${context.getOutput<string>('a')}-b`;
        },
      },
      {
        id: 'a',
        async run() {
          order.push('a');
          return 'a';
        },
      },
      {
        id: 'c',
        deps: ['b'],
        async run(context) {
          order.push('c');
          return `${context.getOutput<string>('b')}-c`;
        },
      },
    ];

    const result = await runDag(nodes, { concurrency: 2 });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(result.outputs.get('c')).toBe('a-b-c');
    expect(result.errors.size).toBe(0);
    expect(result.cancelled).toBe(false);
  });

  it('并发上限为 3', async () => {
    let active = 0;
    let maxActive = 0;
    const nodes: DagNode[] = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`,
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active--;
        return index;
      },
    }));

    const result = await runDag(nodes, { concurrency: 3 });
    expect(result.outputs.size).toBe(8);
    expect(maxActive).toBe(3);
  });

  it('单节点失败不阻塞依赖节点，并记录错误', async () => {
    const events: DagEvent[] = [];
    const nodes: DagNode[] = [
      {
        id: 'bad',
        async run() {
          throw new Error('boom');
        },
      },
      {
        id: 'dependent',
        deps: ['bad'],
        async run(context) {
          return {
            dependencyMissing: context.getOutput('bad') === undefined,
          };
        },
      },
    ];

    const result = await runDag(nodes, {
      onEvent: (event) => events.push(event),
    });
    expect(result.errors.get('bad')?.message).toBe('boom');
    expect(result.outputs.get('dependent')).toEqual({ dependencyMissing: true });
    expect(events.some((event) => event.type === 'node_error')).toBe(true);
  });

  it('取消后不再启动新节点', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const nodes: DagNode[] = [
      {
        id: 'first',
        async run() {
          started.push('first');
          await delay(30);
          return 1;
        },
      },
      {
        id: 'second',
        deps: ['first'],
        async run() {
          started.push('second');
          return 2;
        },
      },
      {
        id: 'third',
        deps: ['first'],
        async run() {
          started.push('third');
          return 3;
        },
      },
    ];

    setTimeout(() => controller.abort(), 5);
    const result = await runDag(nodes, {
      concurrency: 2,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(started).not.toContain('second');
    expect(started).not.toContain('third');
  });

  it('节点主动抛 TaskCancelledError 视为取消', async () => {
    const result = await runDag(
      [
        {
          id: 'cancel',
          async run() {
            throw new TaskCancelledError();
          },
        },
      ],
      {},
    );
    expect(result.cancelled).toBe(true);
    expect(result.errors.size).toBe(0);
  });
});
