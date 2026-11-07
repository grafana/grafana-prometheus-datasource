import { fireEvent, render, screen } from '@testing-library/react';

import { type ExemplarTraceIdDestination } from '../types';

import { ExemplarsSettings, normalizeExemplarDestinations } from './ExemplarsSettings';

const destination: ExemplarTraceIdDestination = { name: 'traceID', url: 'https://example.com/${__value.raw}' };

describe('normalizeExemplarDestinations', () => {
  it('returns arrays and nullish values unchanged', () => {
    expect(normalizeExemplarDestinations([destination])).toEqual([destination]);
    expect(normalizeExemplarDestinations([])).toEqual([]);
    expect(normalizeExemplarDestinations(undefined)).toBeUndefined();
    expect(normalizeExemplarDestinations(null)).toBeUndefined();
  });

  it('wraps a single destination object in an array', () => {
    expect(normalizeExemplarDestinations(destination)).toEqual([destination]);
  });

  it('ignores values that are neither arrays nor objects', () => {
    expect(normalizeExemplarDestinations('traceID')).toBeUndefined();
    expect(normalizeExemplarDestinations(123)).toBeUndefined();
  });
});

describe('ExemplarsSettings', () => {
  // Provisioning can store a non-array value here despite the type.
  const asProvisioned = (value: unknown) => value as ExemplarTraceIdDestination[];

  it('renders a single destination provisioned as an object instead of crashing', () => {
    render(<ExemplarsSettings options={asProvisioned(destination)} onChange={() => {}} />);

    expect(screen.getByDisplayValue('traceID')).toBeInTheDocument();
  });

  it('saves a destination provisioned as an object back as an array when adding another', () => {
    const onChange = jest.fn();
    render(<ExemplarsSettings options={asProvisioned(destination)} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onChange).toHaveBeenCalledWith([destination, { name: 'traceID' }]);
  });

  it('renders without destinations when provisioned as a non-object value', () => {
    render(<ExemplarsSettings options={asProvisioned('traceID')} onChange={() => {}} />);

    expect(screen.queryByDisplayValue('traceID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });
});
