// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/wire.js registers every handler BEFORE
// connect() and delegates to the UrdbApp of src/app.js). Read-only: only GET
// requests to the OpenEI Utility Rate Database leave.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { UrdbApp } from './src/app.js';
import { wire } from './src/wire.js';

const gladys = new GladysIntegration();
const app = new UrdbApp({ gladys });
wire(gladys, app, logger);

logger.info('Starting the OpenEI URDB tariffs integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
