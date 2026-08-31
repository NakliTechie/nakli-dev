import relaySource from './compos-relay.mjs';
import { createArtifactWorker } from './relay-worker-core.mjs';
import setupSource from './setup-local-tls.sh';

export default createArtifactWorker({ relaySource, setupSource });
