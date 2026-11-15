import { useEffect } from 'react';
import { useAppDispatch, useGetAppState } from '../context/AppContext';
import { useApi } from '../hooks/useApi';
import { newDone, runPageTool, type PageContext } from '../assistant/pageTools';
import { startPageChannel } from '../assistant/pageChannel';

/**
 * Lets Bowser's tools (`bowser mcp`, a signed-in Claude) act on this page: runs the commands of
 * the page channel (src/assistant/pageChannel.ts) through the Assistant's page tools. Mounted
 * when the server offers the channel (GET /config: assistant.page_channel).
 */
export default function PageChannel() {
  const dispatch = useAppDispatch();
  const { fetchPointTimeSeries, fetchBufferTimeSeries } = useApi();
  const getState = useGetAppState();

  useEffect(() => startPageChannel({
    run: (name, input) => {
      const ctx: PageContext = {
        getState,
        dispatch,
        api: { fetchPointTimeSeries, fetchBufferTimeSeries },
        done: newDone(),
      };
      return runPageTool(name, input, ctx);
    },
  }), [dispatch, fetchPointTimeSeries, fetchBufferTimeSeries]);

  return null;
}
