import { installSuggestSelectionPreserver, refreshOpenSuggestions } from './suggest_refresh';

type SuggestItem = { textLabel: string; completion: { kind: number } };

function createController(focusedIndex: number, focused?: SuggestItem) {
  const list = { scrollTop: 48, length: 3 };
  const trigger = jest.fn();
  let selector:
    | {
        select: (model: unknown, position: unknown, items: SuggestItem[]) => number;
      }
    | undefined;
  const dispose = jest.fn();
  const controller = {
    model: {
      trigger,
      onDidSuggest: undefined as ((listener: () => void) => { dispose: () => void }) | undefined,
    },
    widget: {
      value: {
        getFocusedItem: () => (focused ? { item: focused, index: focusedIndex } : undefined),
        _list: list,
        _state: 3,
      },
    },
    registerSelector: jest.fn(
      (next: { select: (model: unknown, position: unknown, items: SuggestItem[]) => number }) => {
        selector = next;
        return { dispose };
      }
    ),
  };
  const editor = {
    getContribution: () => controller,
  };
  return { editor, controller, list, trigger, dispose, select: () => selector!.select({}, {}, items()) };
}

function items(): SuggestItem[] {
  return [
    { textLabel: 'up', completion: { kind: 5 } },
    { textLabel: 'uptime', completion: { kind: 5 } },
  ];
}

describe('suggest refresh', () => {
  it('keeps the focused suggestion and restores the list scroll', async () => {
    const harness = createController(1, { textLabel: 'uptime', completion: { kind: 5 } });
    installSuggestSelectionPreserver(harness.editor);

    const index = harness.select();
    harness.list.scrollTop = 0;
    await Promise.resolve();

    expect(index).toBe(1);
    expect(harness.list.scrollTop).toBe(48);
  });

  it('leaves the default row when nothing is focused', () => {
    const harness = createController(-1);
    installSuggestSelectionPreserver(harness.editor);

    expect(harness.select()).toBe(-1);
  });

  it('retriggers the open suggest session when a row is focused', () => {
    const harness = createController(0, { textLabel: 'up', completion: { kind: 5 } });
    refreshOpenSuggestions(harness.editor);

    expect(harness.trigger).toHaveBeenCalledWith({ auto: false, shy: false, noSelect: false }, true);
  });

  it('retriggers while the popup is open even when no row is focused yet', () => {
    const harness = createController(-1);
    refreshOpenSuggestions(harness.editor);

    expect(harness.trigger).toHaveBeenCalledWith({ auto: false, shy: false, noSelect: false }, true);
  });

  it('does not retrigger after the popup is closed', () => {
    const harness = createController(-1);
    harness.controller.widget.value._state = 0;
    refreshOpenSuggestions(harness.editor);

    expect(harness.trigger).not.toHaveBeenCalled();
  });

  it('runs a follow-up refresh when another batch arrives mid-update', () => {
    const harness = createController(0, { textLabel: 'up', completion: { kind: 5 } });
    let notify: (() => void) | undefined;
    harness.controller.model.onDidSuggest = (listener: () => void) => {
      notify = listener;
      return { dispose: () => undefined };
    };

    refreshOpenSuggestions(harness.editor);
    refreshOpenSuggestions(harness.editor);
    expect(harness.trigger).toHaveBeenCalledTimes(1);

    notify?.();
    expect(harness.trigger).toHaveBeenCalledTimes(2);
  });

  it('disposes the selector registration', () => {
    const harness = createController(0, { textLabel: 'up', completion: { kind: 5 } });
    const registration = installSuggestSelectionPreserver(harness.editor);

    registration.dispose();

    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });
});
