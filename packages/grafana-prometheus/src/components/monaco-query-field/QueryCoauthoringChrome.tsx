import { css } from '@emotion/css';
import { type MouseEvent, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { type GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { Button, ClipboardButton, useStyles2 } from '@grafana/ui';

import { type QueryCoauthoringRegistration } from './QueryCoauthoringWidget';

interface Props {
  registration: QueryCoauthoringRegistration;
}

export function QueryCoauthoringChrome({ registration }: Props) {
  const styles = useStyles2(getStyles);
  const snapshot = useSyncExternalStore(registration.subscribe, registration.getSnapshot, registration.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const widgetElement = registration.portalElement;
    const updateRenderedSize = () => {
      const { height, width } = widgetElement.getBoundingClientRect();
      registration.updateRenderedSize({ height, width });
    };

    updateRenderedSize();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const resizeObserver = new ResizeObserver(updateRenderedSize);
    resizeObserver.observe(widgetElement);
    return () => resizeObserver.disconnect();
  }, [registration]);

  useLayoutEffect(() => {
    if (snapshot.mode === 'coauthoring' && hostRef.current) {
      registration.mountAssistant(hostRef.current);
    }
  }, [registration, snapshot.mode]);

  const preserveSelection = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  return createPortal(
    <div
      className={styles.widget}
      data-testid="prometheus-query-coauthoring-widget"
      style={snapshot.mode === 'hidden' ? { display: 'none' } : undefined}
    >
      {snapshot.mode === 'selection-toolbar' && (
        <div className={styles.toolbar}>
          <ClipboardButton
            fill="text"
            getText={registration.getSelectedText}
            onMouseDown={preserveSelection}
            size="sm"
            variant="secondary"
          >
            {t('grafana-prometheus.components.monaco-query-field.copy', 'Copy')}
          </ClipboardButton>
          <span aria-hidden="true" className={styles.divider} />
          <Button
            fill="text"
            icon="ai-sparkle"
            onClick={registration.invoke}
            onMouseDown={preserveSelection}
            size="sm"
            variant="secondary"
          >
            {t('grafana-prometheus.components.monaco-query-field.coauthor', 'Coauthor')}
          </Button>
        </div>
      )}
      <div ref={hostRef} style={snapshot.mode === 'coauthoring' ? undefined : { display: 'none' }} />
    </div>,
    registration.portalElement
  );
}

function getStyles(theme: GrafanaTheme2) {
  return {
    divider: css({
      width: 1,
      alignSelf: 'stretch',
      background: theme.colors.border.weak,
    }),
    toolbar: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(0.5),
      padding: theme.spacing(0.5),
    }),
    widget: css({
      zIndex: theme.zIndex.portal,
      minWidth: 288,
      maxWidth: 360,
      color: theme.colors.text.primary,
      background: theme.colors.background.secondary,
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      boxShadow: theme.shadows.z3,
      overflow: 'hidden',
    }),
  };
}
