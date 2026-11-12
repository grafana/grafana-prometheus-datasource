// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/configuration/ExemplarsSettings.tsx
import { css } from '@emotion/css';

import { selectors } from '@grafana/e2e-selectors';
import { t, Trans } from '@grafana/i18n';
import { ConfigSubSection } from '@grafana/plugin-ui';
import { Alert, Button, useTheme2 } from '@grafana/ui';

import { type ExemplarTraceIdDestination } from '../types';

import { ExemplarSetting } from './ExemplarSetting';
import { overhaulStyles } from './shared/utils';

type Props = {
  options?: ExemplarTraceIdDestination[];
  onChange: (value: ExemplarTraceIdDestination[]) => void;
  disabled?: boolean;
};

export function ExemplarsSettings({ options, onChange, disabled }: Props) {
  const theme = useTheme2();
  const styles = overhaulStyles(theme);
  // Provisioning can store a non-array here. Ignore it, like the backend does.
  const destinations = Array.isArray(options) ? options : undefined;
  const isInvalid = options != null && !destinations;
  return (
    <div className={styles.sectionBottomPadding}>
      <ConfigSubSection
        title={t('grafana-prometheus.configuration.exemplars-settings.title-exemplars', 'Exemplars')}
        className={styles.container}
      >
        {isInvalid && (
          <Alert
            severity="warning"
            title={t(
              'grafana-prometheus.configuration.exemplars-settings.title-destinations-not-a-list',
              'Exemplar destinations were ignored'
            )}
          >
            <Trans i18nKey="grafana-prometheus.configuration.exemplars-settings.text-destinations-not-a-list">
              The provisioned exemplarTraceIdDestinations value is not a list. Wrap each destination in a list item.
            </Trans>
          </Alert>
        )}
        {destinations &&
          destinations.map((option, index) => {
            return (
              <ExemplarSetting
                key={index}
                value={option}
                onChange={(newField) => {
                  const newOptions = [...destinations];
                  newOptions.splice(index, 1, newField);
                  onChange(newOptions);
                }}
                onDelete={() => {
                  const newOptions = [...destinations];
                  newOptions.splice(index, 1);
                  onChange(newOptions);
                }}
                disabled={disabled}
              />
            );
          })}

        {!disabled && (
          <Button
            variant="secondary"
            data-testid={selectors.components.DataSource.Prometheus.configPage.exemplarsAddButton}
            className={css({
              marginBottom: '10px',
            })}
            icon="plus"
            onClick={(event) => {
              event.preventDefault();
              const newOptions = [...(destinations || []), { name: 'traceID' }];
              onChange(newOptions);
            }}
          >
            <Trans i18nKey="grafana-prometheus.configuration.exemplars-settings.add">Add</Trans>
          </Button>
        )}
        {disabled && !destinations && (
          <i>
            <Trans i18nKey="grafana-prometheus.configuration.exemplars-settings.no-exemplars-configurations">
              No exemplars configurations
            </Trans>
          </i>
        )}
      </ConfigSubSection>
    </div>
  );
}
