declare module 'react-plotly.js' {
  import { Component } from 'react';
  import Plotly from 'plotly.js-dist-min';

  interface PlotParams {
    data: Plotly.Data[];
    layout?: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    style?: React.CSSProperties;
    useResizeHandler?: boolean;
    onInitialized?: (figure: Plotly.Figure, graphDiv: HTMLElement) => void;
    onUpdate?: (figure: Plotly.Figure, graphDiv: HTMLElement) => void;
  }

  export default class Plot extends Component<PlotParams> {}
}

declare module 'plotly.js-dist-min' {
  export * from 'plotly.js';
}
