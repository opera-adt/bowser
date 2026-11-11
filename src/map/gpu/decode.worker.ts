/**
 * The GPU renderer's decoder worker: answers decoderPool.ts's requests with zarrita
 * (zarrCube.ts), transferring each chunk's buffer back to the page.
 */
import { serveRequest, type DecodeRequest } from './decoderPool';
import { ZarrSource } from './zarrCube';

const source = new ZarrSource();
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = ev => {
  serveRequest(ev.data, source).then(({ response, transfer }) => scope.postMessage(response, transfer));
};
