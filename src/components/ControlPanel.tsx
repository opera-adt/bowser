import { useEffect, useState, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { baseMaps } from '../basemap';
import { useApi } from '../hooks/useApi';

const colormapOptions = [
  { value: 'rdbu_r', label: 'Blue-Red' },
  { value: 'twilight', label: 'Twilight (cyclic)' },
  { value: 'cfastie', label: 'CFastie' },
  { value: 'rplumbo', label: 'RPlumbo' },
  { value: 'schwarzwald', label: 'Schwarzwald (elevation)' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'bugn', label: 'Blue-Green' },
  { value: 'ylgn', label: 'Yellow-Green' },
  { value: 'magma', label: 'Magma' },
  { value: 'gist_earth', label: 'Earth' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'terrain', label: 'Terrain' },
];

export default function ControlPanel() {
  const { state, dispatch } = useAppContext();
  const { fetchPointTimeSeries } = useApi();

  // Local controlled drafts so users can type partial numbers like "-0."
  const [draftVmin, setDraftVmin] = useState(String(state.vmin));
  const [draftVmax, setDraftVmax] = useState(String(state.vmax));

  // Keep drafts in sync when state changes from outside (dataset swap, loadPreferences, etc.)
  useEffect(() => setDraftVmin(String(state.vmin)), [state.vmin]);
  useEffect(() => setDraftVmax(String(state.vmax)), [state.vmax]);

  // Persist *current* state to localStorage whenever it changes
  useEffect(() => {
    const datasetName = state.currentDataset;
    if (!datasetName) return;

    const safeNumToString = (x: number) => (Object.is(x, -0) ? '-0' : String(x));

    localStorage.setItem(`${datasetName}-colormap_name`, state.colormap);
    localStorage.setItem(`${datasetName}-vmin`, safeNumToString(state.vmin));
    localStorage.setItem(`${datasetName}-vmax`, safeNumToString(state.vmax));
  }, [state.colormap, state.vmin, state.vmax]);

  // On first load / dataset change, read preferences and push into state once
  useEffect(() => {
    const datasetName = state.currentDataset;
    if (!datasetName) return;

    const colormap = localStorage.getItem(`${datasetName}-colormap_name`);
    const vminStr = localStorage.getItem(`${datasetName}-vmin`);
    const vmaxStr = localStorage.getItem(`${datasetName}-vmax`);

    if (colormap) dispatch({ type: 'SET_COLORMAP', payload: colormap });

    if (vminStr !== null) {
      const v = Number(vminStr);
      if (!Number.isNaN(v)) dispatch({ type: 'SET_VMIN', payload: v });
    }
    if (vmaxStr !== null) {
      const v = Number(vmaxStr);
      if (!Number.isNaN(v)) dispatch({ type: 'SET_VMAX', payload: v });
    }
  }, [state.currentDataset, dispatch]);

  const handleDatasetChange = (datasetName: string) => {
    dispatch({ type: 'SET_CURRENT_DATASET', payload: datasetName });

    const currentDatasetInfo = state.datasetInfo[datasetName];
    if (currentDatasetInfo?.uses_spatial_ref && !state.refValues[datasetName]) {
      setRefValues(datasetName);
    }
  };

  const handleTimeIndexChange = (newIndex: number) => {
    dispatch({ type: 'SET_TIME_INDEX', payload: newIndex });
  };

  const handleColormapChange = (colormap: string) => {
    dispatch({ type: 'SET_COLORMAP', payload: colormap });
  };

  const commitVmin = useCallback(() => {
    const v = Number(draftVmin);
    if (!Number.isNaN(v)) {
      dispatch({ type: 'SET_VMIN', payload: v });
    }
  }, [draftVmin, dispatch]);

  const commitVmax = useCallback(() => {
    const v = Number(draftVmax);
    if (!Number.isNaN(v)) {
      dispatch({ type: 'SET_VMAX', payload: v });
    }
  }, [draftVmax, dispatch]);

  const handleOpacityChange = (opacity: number) => {
    dispatch({ type: 'SET_OPACITY', payload: opacity });
  };

  const handleBasemapChange = (basemapKey: string) => {
    dispatch({ type: 'SET_BASEMAP', payload: basemapKey });
  };

  const toggleChart = () => {
    dispatch({ type: 'TOGGLE_CHART' });
  };

  const setRefValues = async (datasetName: string) => {
    const [lat, lng] = state.refMarkerPosition;
    try {
      const values = await fetchPointTimeSeries(lng, lat, datasetName);
      if (values) {
        dispatch({
          type: 'SET_REF_VALUES',
          payload: { dataset: datasetName, values }
        });
      }
    } catch (error) {
      console.error('Error setting reference values:', error);
    }
  };

  const currentDatasetInfo = state.currentDataset ? state.datasetInfo[state.currentDataset] : null;
  const currentTimeValue = currentDatasetInfo ? currentDatasetInfo.x_values[state.currentTimeIndex] : '';

  return (
    <div id="menu">
      <div id="menu-content" className="pure-form">
        {/* Dataset Selector */}
        <div className="menu-group">
          <div>
            <i className="fa-solid fa-layer-group"></i> Layers
          </div>
          <div className="select-container">
            <select
              value={state.currentDataset}
              onChange={(e) => handleDatasetChange(e.target.value)}
            >
              {Object.keys(state.datasetInfo).map((datasetName) => (
                <option key={datasetName} value={datasetName}>
                  {datasetName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Time Slider */}
        {currentDatasetInfo && (
          <div className="menu-group">
            <label htmlFor="layer-slider">
              Viewing Image: <span id="layer-slider-value">{currentTimeValue}</span>
            </label>
            <input
              id="layer-slider"
              className="input"
              type="range"
              min="0"
              max={currentDatasetInfo.x_values.length - 1}
              step="1"
              value={state.currentTimeIndex}
              onChange={(e) => handleTimeIndexChange(parseInt(e.target.value))}
            />
          </div>
        )}

        {/* Colormap Section */}
        <div className="menu-group">
          <div id="colormap-section">
            <div>
              <i className="fa-solid fa-palette"></i> Color Map
            </div>
            <div className="select-container">
              <select
                value={state.colormap}
                onChange={(e) => handleColormapChange(e.target.value)}
              >
                {colormapOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <img
              id="colormap-img"
              src={`/colorbar/${state.colormap}`}
              style={{ maxWidth: '100%', height: 'auto' }}
              alt="Colormap"
            />
          </div>

          {/* Min/Max Controls */}
          <div id="minmax-data">
            <div>Rescale color limits</div>
            <div>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                value={draftVmin}
                onChange={(e) => setDraftVmin(e.target.value)}
                onBlur={commitVmin}
                onKeyDown={(e) => e.key === 'Enter' && commitVmin()}
              />
            </div>
            <div>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                value={draftVmax}
                onChange={(e) => setDraftVmax(e.target.value)}
                onBlur={commitVmax}
                onKeyDown={(e) => e.key === 'Enter' && commitVmax()}
              />
            </div>
          </div>
        </div>

        {/* Opacity Slider */}
        <div className="menu-group pure-form">
          <div id="opacity-slider-container">
            <div>
              <label htmlFor="opacity-slider">
                Opacity: <span id="opacity-slider-value">{state.opacity}</span>
              </label>
            </div>
            <input
              id="opacity-slider"
              className="input"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={state.opacity}
              onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
            />
          </div>
        </div>

        {/* Basemap Selector */}
        <div className="select-container">
          Basemap:
          <select
            value={state.selectedBasemap}
            onChange={(e) => handleBasemapChange(e.target.value)}
          >
            {Object.entries(baseMaps).map(([key]) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Chart Control */}
      <div className="menu-group">
        <div id="menu-chart">
          <button
            className="pure-button pure-button-primary"
            onClick={toggleChart}
          >
            {state.showChart ? 'Hide time series' : 'Show time series'}
          </button>
        </div>
      </div>
    </div>
  );
}
