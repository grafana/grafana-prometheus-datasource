import { fireEvent, render, screen } from '@testing-library/react';

import { createDefaultConfigOptions } from '../test/mocks/datasource';

import { OAuth2ClientCredentialsAuth } from './OAuth2ClientCredentialsAuth';

describe(OAuth2ClientCredentialsAuth.name, () => {
  it('renders empty fields by default', () => {
    render(<OAuth2ClientCredentialsAuth options={createDefaultConfigOptions()} onOptionsChange={() => {}} />);

    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByLabelText('Token URL')).toHaveValue('');
    expect(screen.getByLabelText('Scopes')).toHaveValue('');
  });

  it('updates jsonData.oauth2ClientId when Client ID is edited', () => {
    const onOptionsChange = jest.fn();
    render(<OAuth2ClientCredentialsAuth options={createDefaultConfigOptions()} onOptionsChange={onOptionsChange} />);

    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'my-client' } });

    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ oauth2ClientId: 'my-client' }) })
    );
  });

  it('splits comma-separated Scopes input into an array', () => {
    const onOptionsChange = jest.fn();
    render(<OAuth2ClientCredentialsAuth options={createDefaultConfigOptions()} onOptionsChange={onOptionsChange} />);

    fireEvent.change(screen.getByLabelText('Scopes'), { target: { value: 'read, write' } });

    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ oauth2Scopes: ['read', 'write'] }) })
    );
  });

  it('shows the secret as configured when secureJsonFields.oauth2ClientSecret is true', () => {
    const options = createDefaultConfigOptions();
    options.secureJsonFields = { oauth2ClientSecret: true };
    render(<OAuth2ClientCredentialsAuth options={options} onOptionsChange={() => {}} />);

    expect(screen.getByDisplayValue('configured')).toBeInTheDocument();
  });
});
