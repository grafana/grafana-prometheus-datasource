// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/configuration/PromSettings.test.tsx
import { render, screen } from '@testing-library/react';
import { type SyntheticEvent } from 'react';

import { type SelectableValue } from '@grafana/data';

import { createDefaultConfigOptions } from '../test/mocks/datasource';

import { getValueFromEventItem, PromSettings } from './PromSettings';

describe('PromSettings', () => {
  describe('getValueFromEventItem', () => {
    describe('when called with undefined', () => {
      it('then it should return empty string', () => {
        const result = getValueFromEventItem(
          undefined as unknown as SyntheticEvent<HTMLInputElement> | SelectableValue<string>
        );
        expect(result).toEqual('');
      });
    });

    describe('when called with an input event', () => {
      it('then it should return value from currentTarget', () => {
        const value = 'An input value';
        const result = getValueFromEventItem({ currentTarget: { value } });
        expect(result).toEqual(value);
      });
    });

    describe('when called with a select event', () => {
      it('then it should return value', () => {
        const value = 'A select value';
        const result = getValueFromEventItem({ value });
        expect(result).toEqual(value);
      });
    });
  });

  describe('PromSettings component', () => {
    const defaultProps = createDefaultConfigOptions();

    it('should show POST httpMethod if no httpMethod', () => {
      const options = defaultProps;
      options.url = '';
      options.jsonData.httpMethod = '';

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.getByText('POST')).toBeInTheDocument();
    });
    it('should show POST httpMethod if POST httpMethod is configured', () => {
      const options = defaultProps;
      options.url = 'test_url';
      options.jsonData.httpMethod = 'POST';

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.getByText('POST')).toBeInTheDocument();
    });
    it('should show GET httpMethod if GET httpMethod is configured', () => {
      const options = defaultProps;
      options.url = 'test_url';
      options.jsonData.httpMethod = 'GET';

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.getByText('GET')).toBeInTheDocument();
    });

    it('should have a series endpoint configuration element', () => {
      const options = defaultProps;

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.getByText('Use series endpoint')).toBeInTheDocument();
    });

    it('should have a search API configuration element', () => {
      const options = defaultProps;

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.getByText('Search API')).toBeInTheDocument();
    });

    it('should hide query samples processed threshold fields by default', () => {
      const options = defaultProps;

      render(<PromSettings onOptionsChange={() => {}} options={options} />);
      expect(screen.queryByLabelText('Query warning threshold')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Query error threshold')).not.toBeInTheDocument();
    });

    it('should show query samples processed threshold fields when showQuerySamplesProcessedThresholdFields prop is enabled', () => {
      const options = defaultProps;

      render(<PromSettings onOptionsChange={() => {}} options={options} showQuerySamplesProcessedThresholdFields />);
      expect(screen.getByLabelText('Query warning threshold')).toBeInTheDocument();
      expect(screen.getByLabelText('Query error threshold')).toBeInTheDocument();
    });

    it('should initialize query samples processed threshold fields from options', () => {
      const options = createDefaultConfigOptions();
      options.jsonData.maxSamplesProcessedWarningThreshold = 123;
      options.jsonData.maxSamplesProcessedErrorThreshold = 456;

      render(<PromSettings onOptionsChange={() => {}} options={options} showQuerySamplesProcessedThresholdFields />);

      expect(screen.getByLabelText('Query warning threshold')).toHaveValue('123');
      expect(screen.getByLabelText('Query error threshold')).toHaveValue('456');
    });

    it('should show query samples processed threshold conflict warning when matching keys are set in custom query parameters', () => {
      const options = createDefaultConfigOptions();
      options.jsonData.customQueryParameters =
        'max_samples_processed_warning_threshold=5&max_samples_processed_error_threshold=7';
      options.jsonData.maxSamplesProcessedWarningThreshold = 123;
      options.jsonData.maxSamplesProcessedErrorThreshold = 456;

      render(<PromSettings onOptionsChange={() => {}} options={options} showQuerySamplesProcessedThresholdFields />);

      expect(screen.getByText('Query threshold already set in custom query parameters')).toBeInTheDocument();
    });

    it('should not show query samples processed threshold conflict warning when it is set as a custom query parameter and not set explicitly', () => {
      const options = createDefaultConfigOptions();
      options.jsonData.customQueryParameters = 'max_samples_processed_warning_threshold=5';

      render(<PromSettings onOptionsChange={() => {}} options={options} showQuerySamplesProcessedThresholdFields />);

      expect(screen.queryByText('Query threshold already set in custom query parameters')).not.toBeInTheDocument();
    });
  });
});
