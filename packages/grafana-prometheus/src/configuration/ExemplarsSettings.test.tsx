import { fireEvent, render, screen } from '@testing-library/react';

import { type ExemplarTraceIdDestination } from '../types';

import { ExemplarsSettings } from './ExemplarsSettings';

const destination: ExemplarTraceIdDestination = { name: 'traceID', url: 'https://example.com/${__value.raw}' };

// Provisioning can store a non-array value here despite the type.
const asProvisioned = (value: unknown) => value as ExemplarTraceIdDestination[];

describe('ExemplarsSettings', () => {
  it('renders destinations provisioned as a list', () => {
    render(<ExemplarsSettings options={[destination]} onChange={() => {}} />);

    expect(screen.getByDisplayValue('traceID')).toBeInTheDocument();
    expect(screen.queryByText('Exemplar destinations were ignored')).not.toBeInTheDocument();
  });

  it('does not warn when no destinations are configured', () => {
    render(<ExemplarsSettings options={undefined} onChange={() => {}} />);

    expect(screen.queryByText('Exemplar destinations were ignored')).not.toBeInTheDocument();
  });

  it.each([
    ['a single object', destination],
    ['a string', 'traceID'],
    ['a number', 123],
  ])('ignores a destination provisioned as %s and shows a warning instead of crashing', (_, value) => {
    render(<ExemplarsSettings options={asProvisioned(value)} onChange={() => {}} />);

    expect(screen.getByText('Exemplar destinations were ignored')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('traceID')).not.toBeInTheDocument();
  });

  it('starts a new list when adding a destination after an ignored value', () => {
    const onChange = jest.fn();
    render(<ExemplarsSettings options={asProvisioned(destination)} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onChange).toHaveBeenCalledWith([{ name: 'traceID' }]);
  });
});
