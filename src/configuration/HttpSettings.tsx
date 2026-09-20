import { type DataSourceSettings } from '@grafana/data';
import { Auth, AuthMethod, ConnectionSettings, convertLegacyAuthProps } from '@grafana/plugin-ui';
import { docsTip, OAuth2ClientCredentialsAuth, overhaulStyles, type PromOptions } from '@grafana/prometheus';
import { SecureSocksProxySettings, useTheme2 } from '@grafana/ui';

const OAUTH2_CLIENT_CREDENTIALS_METHOD_ID = 'custom-oauth2-client-credentials' as const;

type Props = {
  options: DataSourceSettings<PromOptions>;
  onOptionsChange: (options: DataSourceSettings<PromOptions>) => void;
  secureSocksDSProxyEnabled: boolean;
};

export const HttpSettings = (props: Props) => {
  const { options, onOptionsChange, secureSocksDSProxyEnabled } = props;

  const newAuthProps = convertLegacyAuthProps({
    config: options,
    onChange: onOptionsChange,
  });

  const selectedMethod = options.jsonData.oauth2ClientCredentialsEnabled
    ? OAUTH2_CLIENT_CREDENTIALS_METHOD_ID
    : newAuthProps.selectedMethod;

  const theme = useTheme2();
  const styles = overhaulStyles(theme);

  // Do we need this switch anymore? Update the language.
  let urlTooltip;
  switch (options.access) {
    case 'direct':
      urlTooltip = (
        <>
          Your access method is <em>Browser</em>, this means the URL needs to be accessible from the browser.
          {docsTip()}
        </>
      );
      break;
    case 'proxy':
      urlTooltip = (
        <>
          Your access method is <em>Server</em>, this means the URL needs to be accessible from the grafana
          backend/server.
          {docsTip()}
        </>
      );
      break;
    default:
      urlTooltip = <>Specify a complete HTTP URL (for example http://your_server:8080) {docsTip()}</>;
  }

  return (
    <>
      <ConnectionSettings
        urlPlaceholder="http://localhost:9090"
        config={options}
        onChange={onOptionsChange}
        urlLabel="Prometheus server URL"
        urlTooltip={urlTooltip}
      />
      <hr className={`${styles.hrTopSpace} ${styles.hrBottomSpace}`} />
      <Auth
        {...newAuthProps}
        onAuthMethodSelect={(method) => {
          onOptionsChange({
            ...options,
            basicAuth: method === AuthMethod.BasicAuth,
            withCredentials: method === AuthMethod.CrossSiteCredentials,
            jsonData: {
              ...options.jsonData,
              oauthPassThru: method === AuthMethod.OAuthForward,
              oauth2ClientCredentialsEnabled: method === OAUTH2_CLIENT_CREDENTIALS_METHOD_ID,
            },
          });
        }}
        // If your method is selected pass its id to `selectedMethod`,
        // otherwise pass the id from converted legacy data
        selectedMethod={selectedMethod}
        // The library default order is [BasicAuth, OAuthForward, NoAuth, ...customMethods],
        // which puts "No Authentication" ahead of custom methods. Override explicitly so it
        // stays last. If another built-in or custom auth method is added, add it here too,
        // before AuthMethod.NoAuth.
        visibleMethods={[AuthMethod.BasicAuth, AuthMethod.OAuthForward, OAUTH2_CLIENT_CREDENTIALS_METHOD_ID, AuthMethod.NoAuth]}
        customMethods={[
          {
            id: OAUTH2_CLIENT_CREDENTIALS_METHOD_ID,
            label: 'OAuth2 Client Credentials',
            description: 'Authenticate using the OAuth2 client credentials grant.',
            component: <OAuth2ClientCredentialsAuth options={options} onOptionsChange={onOptionsChange} />,
          },
        ]}
      />
      <div className={styles.sectionBottomPadding} />
      {secureSocksDSProxyEnabled && (
        <>
          <SecureSocksProxySettings options={options} onOptionsChange={onOptionsChange} />
          <div className={styles.sectionBottomPadding} />
        </>
      )}
    </>
  );
};
