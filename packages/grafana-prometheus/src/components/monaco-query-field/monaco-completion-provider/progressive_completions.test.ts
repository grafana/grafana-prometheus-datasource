import { ProgressiveCompletionSession } from './progressive_completions';

describe('ProgressiveCompletionSession', () => {
  it('opens on the first batch and appends later batches after that list is delivered', async () => {
    const session = new ProgressiveCompletionSession<string>();
    const appended = jest.fn();
    let emit: (batch: string[]) => void = () => undefined;
    let finish: (items: string[]) => void = () => undefined;

    const first = session.load(
      'metric:up',
      (onBatch) => {
        emit = onBatch;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      appended
    );

    emit(['up', 'uptime']);
    const opened = await first;
    expect(opened).toMatchObject({ items: ['up', 'uptime'], incomplete: true, stale: false });
    session.markDelivered(opened.generation);
    expect(appended).not.toHaveBeenCalled();

    emit(['process_start_time']);
    expect(appended).toHaveBeenCalledTimes(1);

    const again = await session.load('metric:up', jest.fn(), appended);
    expect(again).toMatchObject({
      items: ['up', 'uptime', 'process_start_time'],
      incomplete: true,
      stale: false,
    });
    expect(appended).toHaveBeenCalledTimes(1);

    finish(['rate', 'up', 'uptime', 'process_start_time']);
    await Promise.resolve();
    expect(appended).toHaveBeenCalledTimes(2);

    const done = await session.load('metric:up', jest.fn(), appended);
    expect(done).toMatchObject({
      items: ['up', 'uptime', 'process_start_time', 'rate'],
      incomplete: false,
      stale: false,
    });
  });

  it('returns a finished series list once and does not append before it is delivered', async () => {
    const session = new ProgressiveCompletionSession<string>();
    const appended = jest.fn();
    let finish: (items: string[]) => void = () => undefined;

    const pending = session.load(
      'labels',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      appended
    );

    finish(['job', 'instance']);
    await expect(pending).resolves.toMatchObject({
      items: ['job', 'instance'],
      incomplete: false,
      stale: false,
    });
    expect(appended).not.toHaveBeenCalled();
  });

  it('drops batches from a search that was replaced', async () => {
    const session = new ProgressiveCompletionSession<string>();
    let emitFirst: (batch: string[]) => void = () => undefined;
    let emitSecond: (batch: string[]) => void = () => undefined;

    const first = session.load(
      'metric:up',
      (onBatch) => {
        emitFirst = onBatch;
        return new Promise(() => undefined);
      },
      jest.fn()
    );

    const second = session.load(
      'metric:go',
      (onBatch) => {
        emitSecond = onBatch;
        return new Promise(() => undefined);
      },
      jest.fn()
    );

    emitFirst(['up']);
    await expect(first).resolves.toMatchObject({ items: [], stale: true });

    emitSecond(['go_goroutines']);
    await expect(second).resolves.toMatchObject({ items: ['go_goroutines'], stale: false, incomplete: true });
  });
});
