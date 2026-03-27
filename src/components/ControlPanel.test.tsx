import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ControlPanel from './ControlPanel';
import { AppProvider } from '../context/AppContext';

// Mock the useApi hook since we don't need actual API calls
vi.mock('../hooks/useApi', () => ({
  useApi: () => ({
    fetchPointTimeSeries: vi.fn(),
  }),
}));

describe('ControlPanel localStorage', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('saves colormap settings to localStorage when changed', async () => {
    const user = userEvent.setup();

    render(
      <AppProvider>
        <ControlPanel />
      </AppProvider>
    );

    // Find and change the colormap selector
    const colormapSelect = screen.getByDisplayValue('Blue-Red');
    await user.selectOptions(colormapSelect, 'viridis');

    // Wait for the effect to save to localStorage
    await waitFor(() => {
      expect(localStorage.getItem('dataset-a-colormap_name')).toBe('viridis');
    });
  });

  it('does not overwrite new dataset settings when switching datasets', async () => {
    const user = userEvent.setup();

    // Pre-populate localStorage with saved settings for both datasets
    localStorage.setItem('dataset-a-colormap_name', 'viridis');
    localStorage.setItem('dataset-b-colormap_name', 'magma');

    render(
      <AppProvider>
        <ControlPanel />
      </AppProvider>
    );

    // Initially on dataset-a, should load viridis
    await waitFor(() => {
      const colormapSelect = screen.getByRole('combobox', { name: /color map/i });
      expect(colormapSelect).toHaveValue('viridis');
    });

    // Switch to dataset-b
    const datasetSelect = screen.getByRole('combobox', { name: /layers/i });
    await user.selectOptions(datasetSelect, 'dataset-b');

    // Should load magma (dataset-b's saved colormap)
    await waitFor(() => {
      const colormapSelect = screen.getByRole('combobox', { name: /color map/i });
      expect(colormapSelect).toHaveValue('magma');
    });

    // Verify that dataset-b's localStorage was NOT overwritten with dataset-a's value
    expect(localStorage.getItem('dataset-b-colormap_name')).toBe('magma');
  });

  it('preserves color limits when switching between datasets', async () => {
    const user = userEvent.setup();

    localStorage.setItem('dataset-a-vmin', '-10');
    localStorage.setItem('dataset-a-vmax', '10');
    localStorage.setItem('dataset-b-vmin', '-5');
    localStorage.setItem('dataset-b-vmax', '5');

    render(
      <AppProvider>
        <ControlPanel />
      </AppProvider>
    );

    // On dataset-a, should load -10/10
    await waitFor(() => {
      const vminInputs = screen.getAllByRole('textbox', { name: '' });
      expect(vminInputs[0]).toHaveValue('-10');
      expect(vminInputs[1]).toHaveValue('10');
    });

    // Switch to dataset-b
    const datasetSelect = screen.getByRole('combobox', { name: /layers/i });
    await user.selectOptions(datasetSelect, 'dataset-b');

    // Should load -5/5 (dataset-b's saved limits)
    await waitFor(() => {
      const vminInputs = screen.getAllByRole('textbox', { name: '' });
      expect(vminInputs[0]).toHaveValue('-5');
      expect(vminInputs[1]).toHaveValue('5');
    });

    // Switch back to dataset-a
    await user.selectOptions(datasetSelect, 'dataset-a');

    // Should load -10/10 again (dataset-a's saved limits)
    await waitFor(() => {
      const vminInputs = screen.getAllByRole('textbox', { name: '' });
      expect(vminInputs[0]).toHaveValue('-10');
      expect(vminInputs[1]).toHaveValue('10');
    });
  });
});
