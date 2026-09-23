// Monaco hides the suggest widget when editor.action.triggerSuggest runs, then
// focuses row 0. A batch update retriggers the open session and points the
// selector back at the row that was already focused.

const SUGGEST_CONTROLLER_ID = 'editor.contrib.suggestController';

type SuggestItem = {
  textLabel: string;
  completion: { kind: number };
};

type SuggestWidgetLike = {
  getFocusedItem: () => { item?: SuggestItem; index: number } | undefined;
  _list: { scrollTop: number };
};

type SuggestControllerLike = {
  model?: {
    trigger: (context: { auto: boolean; shy: boolean; noSelect: boolean }, retrigger?: boolean) => void;
  };
  widget?: { value?: SuggestWidgetLike } | SuggestWidgetLike;
  registerSelector?: (selector: {
    priority: number;
    select: (model: unknown, position: unknown, items: SuggestItem[]) => number;
  }) => { dispose: () => void };
};

export type SuggestRefreshEditor = {
  getContribution?: (id: string) => unknown;
};

function getController(editor: SuggestRefreshEditor): SuggestControllerLike | undefined {
  const controller = editor.getContribution?.(SUGGEST_CONTROLLER_ID) as SuggestControllerLike | null | undefined;
  return controller ?? undefined;
}

function getWidget(controller: SuggestControllerLike): SuggestWidgetLike | undefined {
  const widget = controller.widget;
  if (!widget) {
    return undefined;
  }
  if ('value' in widget && widget.value && typeof widget.value.getFocusedItem === 'function') {
    return widget.value;
  }
  if (typeof (widget as SuggestWidgetLike).getFocusedItem === 'function') {
    return widget as SuggestWidgetLike;
  }
  return undefined;
}

export function installSuggestSelectionPreserver(editor: SuggestRefreshEditor): { dispose: () => void } {
  const controller = getController(editor);
  if (!controller?.registerSelector) {
    return { dispose: () => undefined };
  }

  return controller.registerSelector({
    priority: 100,
    select: (_model, _position, items) => {
      const widget = getWidget(controller);
      const focused = widget?.getFocusedItem()?.item;
      if (!widget || !focused) {
        return -1;
      }

      const scrollTop = widget._list.scrollTop;
      const index = items.findIndex(
        (item) => item.textLabel === focused.textLabel && item.completion.kind === focused.completion.kind
      );
      if (index < 0) {
        return -1;
      }

      queueMicrotask(() => {
        widget._list.scrollTop = scrollTop;
      });
      return index;
    },
  });
}

export function refreshOpenSuggestions(editor: SuggestRefreshEditor): void {
  const controller = getController(editor);
  const widget = controller ? getWidget(controller) : undefined;
  const focusedIndex = widget?.getFocusedItem()?.index ?? -1;
  if (!controller?.model || focusedIndex < 0) {
    return;
  }

  // retrigger=true keeps the popup mounted. triggerSuggest passes false and hides it.
  controller.model.trigger({ auto: false, shy: false, noSelect: false }, true);
}
