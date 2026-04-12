import { useState } from 'react';
import { useAppContext } from '../context/AppContext';

export default function PointManagerPanel() {
  const { state, dispatch } = useAppContext();
  const [showPanel, setShowPanel] = useState(false);

  const handleTogglePointVisibility = (pointId: string) => {
    const point = state.timeSeriesPoints.find(p => p.id === pointId);
    if (point) {
      dispatch({
        type: 'UPDATE_TIME_SERIES_POINT',
        payload: {
          id: pointId,
          updates: { visible: !point.visible }
        }
      });
    }
  };

  const handlePointNameChange = (pointId: string, newName: string) => {
    dispatch({
      type: 'UPDATE_TIME_SERIES_POINT',
      payload: {
        id: pointId,
        updates: { name: newName }
      }
    });
  };

  const handleRemovePoint = (pointId: string) => {
    dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: pointId });
  };

  const handleSelectPoint = (pointId: string) => {
    dispatch({ type: 'SET_SELECTED_POINT', payload: pointId });
  };

  const handleClearAllPoints = () => {
    if (confirm('Remove all time series points?')) {
      state.timeSeriesPoints.forEach(point => {
        dispatch({ type: 'REMOVE_TIME_SERIES_POINT', payload: point.id });
      });
    }
  };

  const handleToggleTrends = () => {
    dispatch({ type: 'TOGGLE_TRENDS' });
  };

  if (!showPanel) {
    return (
      <div className="point-manager-toggle">
        <button
          className="pure-button"
          onClick={() => setShowPanel(true)}
          title="Manage Time Series Points"
        >
          <i className="fa-solid fa-list"></i> Points ({state.timeSeriesPoints.length})
        </button>
      </div>
    );
  }

  return (
    <div className="point-manager-panel">
      <div className="point-manager-header">
        <h3>
          <i className="fa-solid fa-map-pin"></i> Time Series Points
        </h3>
        <button
          className="pure-button"
          onClick={() => setShowPanel(false)}
          title="Close Panel"
        >
          <i className="fa-solid fa-times"></i>
        </button>
      </div>

      <div className="point-manager-controls">
        <button
          className="pure-button pure-button-primary"
          onClick={handleToggleTrends}
          title="Toggle trend display"
        >
          <i className={`fa-solid ${state.showTrends ? 'fa-eye-slash' : 'fa-eye'}`}></i>
          {state.showTrends ? 'Hide' : 'Show'} Trends
        </button>
        
        {state.timeSeriesPoints.length > 0 && (
          <button
            className="pure-button button-warning"
            onClick={handleClearAllPoints}
            title="Remove all points"
          >
            <i className="fa-solid fa-trash"></i> Clear All
          </button>
        )}
      </div>

      <div className="point-list">
        {state.timeSeriesPoints.length === 0 ? (
          <div className="no-points">
            <p>No time series points selected.</p>
            <p><small>Click on the map to add points.</small></p>
          </div>
        ) : (
          state.timeSeriesPoints.map((point) => (
            <div 
              key={point.id} 
              className={`point-item ${state.selectedPointId === point.id ? 'selected' : ''}`}
              onClick={() => handleSelectPoint(point.id)}
            >
              <div className="point-item-header">
                <div 
                  className="point-color-indicator"
                  style={{ backgroundColor: point.color }}
                ></div>
                <input
                  type="text"
                  value={point.name}
                  onChange={(e) => handlePointNameChange(point.id, e.target.value)}
                  className="point-name-input"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              
              <div className="point-item-info">
                <div className="point-coordinates">
                  <small>
                    Lat: {point.position[0].toFixed(6)}, 
                    Lon: {point.position[1].toFixed(6)}
                  </small>
                </div>
                
                {state.showTrends && point.trendData && point.trendData[state.currentDataset] && (
                  <div className="point-trend-info">
                    <small>
                      Rate: {point.trendData[state.currentDataset].mmPerYear?.toFixed(2) || 'N/A'} mm/year
                      (R²: {point.trendData[state.currentDataset].rSquared.toFixed(3)})
                    </small>
                  </div>
                )}
              </div>
              
              <div className="point-item-controls">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTogglePointVisibility(point.id);
                  }}
                  className="pure-button"
                  title={point.visible ? 'Hide point' : 'Show point'}
                >
                  <i className={`fa-solid ${point.visible ? 'fa-eye' : 'fa-eye-slash'}`}></i>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemovePoint(point.id);
                  }}
                  className="pure-button button-error"
                  title="Remove point"
                >
                  <i className="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      
      <div className="point-manager-help">
        <small>
          • Click map to add points<br/>
          • Double-click markers to remove<br/>
          • Drag markers to move
        </small>
      </div>
    </div>
  );
}