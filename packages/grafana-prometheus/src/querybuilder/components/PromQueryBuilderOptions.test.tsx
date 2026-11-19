// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/querybuilder/components/PromQueryBuilderOptions.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { select } from 'react-select-event';

import { CoreApp } from '@grafana/data';

import { type PromQuery } from '../../types';
import { getQueryWithDefaults } from '../state';

import { PromQueryBuilderOptions, type PromQueryBuilderUIOptions } from './PromQueryBuilderOptions';

describe('PromQueryBuilderOptions', () => {
  it('Can change query type', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));
    expect(screen.getByLabelText('Range')).toBeChecked();

    await userEvent.click(screen.getByLabelText('Instant'));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      instant: true,
      range: false,
      exemplar: false,
    });
  });

  it('Can set query type to "Both" on render for PanelEditor', async () => {
    setup({ instant: true, range: true });

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    expect(screen.getByLabelText('Both')).toBeChecked();
  });

  it('Can set query type to "Both" on render for Explorer', async () => {
    setup({ instant: true, range: true }, CoreApp.Explore);

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    expect(screen.getByLabelText('Both')).toBeChecked();
  });

  // CoreApp.Notebook only exists in newer @grafana/data than the one this package builds against.
  const NOTEBOOK_APP = 'notebook' as CoreApp;

  it.each([NOTEBOOK_APP, CoreApp.Dashboard, CoreApp.UnifiedAlerting])(
    'renders a "Both" query without crashing and keeps it selected for %s',
    async (app) => {
      setup({ instant: true, range: true }, app);

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));

      expect(screen.getByLabelText('Both')).toBeChecked();
    }
  );

  it('does not offer "Both" for Notebook when the query is not already "Both"', async () => {
    setup({ instant: false, range: true }, NOTEBOOK_APP);

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    expect(screen.queryByLabelText('Both')).not.toBeInTheDocument();
  });

  it('does not crash on a "Both" query when uiOptions.disableTypeBoth is true', () => {
    setup({ instant: true, range: true }, CoreApp.PanelEditor, { disableTypeBoth: true });

    expect(screen.getByText('Type: Both')).toBeInTheDocument();
  });

  it('Legend format default to Auto', () => {
    setup();
    expect(screen.getByText('Legend: Auto')).toBeInTheDocument();
  });

  it('Can change legend format to verbose', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    let legendModeSelect = screen.getByText('Auto').parentElement!;
    await userEvent.click(legendModeSelect);

    await waitFor(() => select(legendModeSelect, 'Verbose', { container: document.body }));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      legendFormat: '',
    });
  });

  it('Can change legend format to custom', async () => {
    const { props } = setup();

    await userEvent.click(screen.getByRole('button', { name: /Options/ }));

    let legendModeSelect = screen.getByText('Auto').parentElement!;
    await userEvent.click(legendModeSelect);

    await waitFor(() => select(legendModeSelect, 'Custom', { container: document.body }));

    expect(props.onChange).toHaveBeenCalledWith({
      ...props.query,
      legendFormat: '{{label_name}}',
    });
  });

  it('Handle defaults with undefined range', () => {
    setup(getQueryWithDefaults({ refId: 'A', expr: '', range: undefined, instant: true }, CoreApp.Dashboard));

    expect(screen.getByText('Type: Instant')).toBeInTheDocument();
  });

  it('Should show "Exemplars: false" by default', () => {
    setup();
    expect(screen.getByText('Exemplars: false')).toBeInTheDocument();
  });

  it('Should show "Exemplars: false" when query has "Exemplars: false"', () => {
    setup({ exemplar: false });
    expect(screen.getByText('Exemplars: false')).toBeInTheDocument();
  });

  it('Should show "Exemplars: true" when query has "Exemplars: true"', () => {
    setup({ exemplar: true });
    expect(screen.getByText('Exemplars: true')).toBeInTheDocument();
  });

  describe('uiOptions', () => {
    it('hides exemplars switch when uiOptions.exemplars is false', async () => {
      setup({}, CoreApp.PanelEditor, { exemplars: false });
      expect(screen.queryByText(/Exemplars:/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      expect(screen.queryByLabelText('Exemplars switch.')).not.toBeInTheDocument();
    });

    it('hides legend section when uiOptions.legend is false', async () => {
      setup({}, CoreApp.PanelEditor, { legend: false });
      expect(screen.queryByText(/Legend:/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('hides type section when uiOptions.type is false', async () => {
      setup({}, CoreApp.PanelEditor, { type: false });
      expect(screen.queryByText(/Type:/)).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
    });

    it('removes the "Both" type option when uiOptions.disableTypeBoth is true', async () => {
      // PanelEditor would normally offer "Both"
      setup({}, CoreApp.PanelEditor, { disableTypeBoth: true });

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      expect(screen.getByLabelText('Range')).toBeInTheDocument();
      expect(screen.getByLabelText('Instant')).toBeInTheDocument();
      expect(screen.queryByLabelText('Both')).not.toBeInTheDocument();
    });

    it('keeps the app-based "Both" option when uiOptions.disableTypeBoth is undefined', async () => {
      setup({}, CoreApp.PanelEditor, {});

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      expect(screen.getByLabelText('Both')).toBeInTheDocument();
    });
  });

  describe('formatOptions', () => {
    it('uses the custom format options when provided', async () => {
      setup({ format: 'table' }, CoreApp.PanelEditor, undefined, [
        { label: 'Time series', value: 'time_series' },
        { label: 'Table', value: 'table' },
      ]);

      expect(screen.getByText('Format: Table')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Options/ }));
      await userEvent.click(screen.getByLabelText('Format combobox'));
      expect(screen.queryByText('Heatmap')).not.toBeInTheDocument();
    });
  });
});

function setup(
  queryOverrides: Partial<PromQuery> = {},
  app: CoreApp = CoreApp.PanelEditor,
  uiOptions?: PromQueryBuilderUIOptions,
  formatOptions?: Parameters<typeof PromQueryBuilderOptions>[0]['formatOptions']
) {
  const props = {
    app,
    query: {
      ...getQueryWithDefaults(
        {
          refId: 'A',
          expr: '',
          range: true,
          instant: false,
        } as PromQuery,
        CoreApp.PanelEditor
      ),
      ...queryOverrides,
    },
    onRunQuery: jest.fn(),
    onChange: jest.fn(),
    uiOptions,
    formatOptions,
  };

  const { container } = render(<PromQueryBuilderOptions {...props} />);
  return { container, props };
}
