import { useEffect, useState } from 'react';
import { AppProvider, useAppContext } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import MapContainer from './MapContainer';
import MapLibreMap from './MapLibreMap';

import { browserHasWebGL2, chooseMap } from '../map/mapChoice';
import { startData } from '../map/addData';
import { useAddServerData } from '../hooks/useAddFiles';
import { chartLayerFor } from '../utils/chartLayers';
import { defaultMasks } from '../utils/defaultMasks';
import { applyTheme, readThemeChoice } from '../utils/theme';

applyTheme(readThemeChoice());

/** MapLibre by default; Leaflet with ``?map=leaflet`` or when WebGL2 isn't available. */
const USE_MAPLIBRE = chooseMap(window.location.search, browserHasWebGL2) === 'maplibre';
import ControlPanel from './ControlPanel';
import PageChannel from './PageChannel';
import TimeSeriesChart from './TimeSeriesChart';
import PointManagerPanel from './PointManagerPanel';
import RefPointChart from './RefPointChart';
import ColormapBar from './ColormapBar';
import FileDrop from './FileDrop';
import IdentifyPanel from './IdentifyPanel';
import GnssChartWindow from './GnssChartWindow';
import MapLegend from './MapLegend';
import DateBadge from './DateBadge';
import LosIndicator from './LosIndicator';
import { ProfileProvider, ProfileChart } from './ProfileTool';
import '../style.css';

function AppContent() {
  const { state, dispatch } = useAppContext();
  const addServerData = useAddServerData();
  const { fetchDatasets, fetchDataMode, fetchConfig } = useApi();
  const [appTitle, setAppTitle] = useState('');
  // The Bowser mark unless the server asks for the OPERA emblem (bowser run --opera-logo).
  const [operaLogo, setOperaLogo] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [toolbarsVisible, setToolbarsVisible] = useState(true);
  // Bowser's tools may act on this page (the server says so on the user's own computer).
  const [pageChannel, setPageChannel] = useState(false);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Fetch config (title), data mode, and datasets
        const [config, mode] = await Promise.all([fetchConfig(), fetchDataMode()]);
        setOperaLogo(config.opera_logo === true);
        setPageChannel(config.assistant?.page_channel === true);

        if (config.title) {
          setAppTitle(config.title);
          document.title = config.title;
        }

        dispatch({ type: 'SET_DATA_MODE', payload: mode });
        // `bowser run --overlay`: the server's own files, as layers from the start.
        for (const path of config.overlay_files ?? []) {
          startData(path).then(addServerData).catch(err => dispatch({
            type: 'SET_OVERLAY_MESSAGE', payload: `Could not add ${path}: ${(err as Error).message}`,
          }));
        }

        const datasets = await fetchDatasets();
        dispatch({ type: 'SET_DATASETS', payload: datasets });
        defaultMasks(datasets).forEach(mask => dispatch({ type: 'ADD_LAYER_MASK', payload: mask }));

        // Open on displacement rather than whichever variable the cube lists first.
        const firstDataset = chartLayerFor('', datasets) ?? Object.keys(datasets)[0];
        if (firstDataset) {
          dispatch({ type: 'SET_CURRENT_DATASET', payload: firstDataset });

          const bounds = datasets[firstDataset].latlon_bounds;
          const centerLat = (bounds[1] + bounds[3]) / 2;
          const centerLng = (bounds[0] + bounds[2]) / 2;

          dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [centerLat, centerLng] });
        }
      } catch (error) {
        console.error('Error initializing app:', error);
      }
    };

    initializeApp();
  }, [fetchDatasets, fetchDataMode, fetchConfig, dispatch, addServerData]);

  return (
    <div className={`app-container${sidebarHidden ? ' sidebar-hidden' : ''}`}>
      {pageChannel && <PageChannel />}
      <ControlPanel title={appTitle} operaLogo={operaLogo} />
      <div className="map-container">
        <button
          className="sidebar-toggle-btn"
          data-command="panel.sidebar"
          onClick={() => setSidebarHidden(h => !h)}
          title={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
        >
          <i className={`fa-solid fa-chevron-${sidebarHidden ? 'right' : 'left'}`} />
        </button>
        {USE_MAPLIBRE
          ? <MapLibreMap toolbarsVisible={toolbarsVisible} onToggleToolbars={() => setToolbarsVisible(v => !v)} />
          : <MapContainer toolbarsVisible={toolbarsVisible} onToggleToolbars={() => setToolbarsVisible(v => !v)} />}
        {toolbarsVisible && <PointManagerPanel />}
        <RefPointChart />
        <FileDrop />
        <MapLegend />
        <DateBadge />
        <IdentifyPanel />
        <GnssChartWindow />
        <ColormapBar />
        <LosIndicator />
        <ProfileChart />
        {state.showChart && state.chartWindows.map(w => (
          <TimeSeriesChart key={w.id} windowId={w.id} />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <ProfileProvider>
        <AppContent />
      </ProfileProvider>
    </AppProvider>
  );
}
