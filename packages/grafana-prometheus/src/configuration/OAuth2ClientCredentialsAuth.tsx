import { type DataSourceSettings } from '@grafana/data';
import { t } from '@grafana/i18n';
import { InlineField, Input, SecretInput } from '@grafana/ui';

import { PROM_CONFIG_LABEL_WIDTH } from '../constants';
import { type PromOptions } from '../types';

type OAuth2SecureJsonData = {
  oauth2ClientSecret?: string;
};

type Props = {
  options: DataSourceSettings<PromOptions, OAuth2SecureJsonData>;
  onOptionsChange: (options: DataSourceSettings<PromOptions, OAuth2SecureJsonData>) => void;
};

export const OAuth2ClientCredentialsAuth = ({ options, onOptionsChange }: Props) => {
  const jsonData = options.jsonData;

  const onScopesChange = (value: string) => {
    const scopes = value
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
    onOptionsChange({ ...options, jsonData: { ...jsonData, oauth2Scopes: scopes } });
  };

  return (
    <div className="gf-form-group">
      <InlineField
        label={t('grafana-prometheus.configuration.o-auth2-client-credentials-auth.label-client-id', 'Client ID')}
        labelWidth={PROM_CONFIG_LABEL_WIDTH}
        interactive={true}
      >
        <Input
          width={40}
          value={jsonData.oauth2ClientId ?? ''}
          onChange={(event) =>
            onOptionsChange({ ...options, jsonData: { ...jsonData, oauth2ClientId: event.currentTarget.value } })
          }
        />
      </InlineField>
      <InlineField
        label={t(
          'grafana-prometheus.configuration.o-auth2-client-credentials-auth.label-client-secret',
          'Client secret'
        )}
        labelWidth={PROM_CONFIG_LABEL_WIDTH}
        interactive={true}
      >
        <SecretInput
          width={40}
          isConfigured={Boolean(options.secureJsonFields?.oauth2ClientSecret)}
          value={options.secureJsonData?.oauth2ClientSecret ?? ''}
          onReset={() =>
            onOptionsChange({
              ...options,
              secureJsonFields: { ...options.secureJsonFields, oauth2ClientSecret: false },
              secureJsonData: { ...options.secureJsonData, oauth2ClientSecret: '' },
            })
          }
          onChange={(event) =>
            onOptionsChange({
              ...options,
              secureJsonData: { ...options.secureJsonData, oauth2ClientSecret: event.currentTarget.value },
            })
          }
        />
      </InlineField>
      <InlineField
        label={t('grafana-prometheus.configuration.o-auth2-client-credentials-auth.label-token-url', 'Token URL')}
        labelWidth={PROM_CONFIG_LABEL_WIDTH}
        interactive={true}
      >
        <Input
          width={40}
          placeholder={t(
            'grafana-prometheus.configuration.o-auth2-client-credentials-auth.placeholder-token-url',
            'https://example.com/oauth2/token'
          )}
          value={jsonData.oauth2TokenUrl ?? ''}
          onChange={(event) =>
            onOptionsChange({ ...options, jsonData: { ...jsonData, oauth2TokenUrl: event.currentTarget.value } })
          }
        />
      </InlineField>
      <InlineField
        label={t('grafana-prometheus.configuration.o-auth2-client-credentials-auth.label-scopes', 'Scopes')}
        labelWidth={PROM_CONFIG_LABEL_WIDTH}
        tooltip={t(
          'grafana-prometheus.configuration.o-auth2-client-credentials-auth.tooltip-scopes',
          'Comma-separated list of scopes to request from the token endpoint.'
        )}
        interactive={true}
      >
        <Input
          width={40}
          placeholder={t(
            'grafana-prometheus.configuration.o-auth2-client-credentials-auth.placeholder-scopes',
            'read, write'
          )}
          value={(jsonData.oauth2Scopes ?? []).join(', ')}
          onChange={(event) => onScopesChange(event.currentTarget.value)}
        />
      </InlineField>
    </div>
  );
};
