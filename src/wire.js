// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app: used by index.js and by the tests (so
// that the tests go through the same wiring). Every handler is registered
// before connect(). No device: a `provider` integration made of energy
// contract templates priced by the integration (delegated mode).
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {import('./app.js').UrdbApp} app
 */
export function wire(gladys, app, logger) {
  // --- Delegated pricing ----------------------------------------------------------
  // Gladys sends the 30-minute intervals of one billing period (≤ 31 days,
  // ack awaited under 30 s) and the current instant (under 5 s).
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));

  // --- Buttons of the configuration screen ------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.FIND, (fields) => app.findTariffs(fields));

  // --- Configuration changed by the user ------------------------------------------
  gladys.onConfigUpdated((config) => {
    logger.info('Configuration updated');
    return app.configUpdated(config);
  });

  // --- Connection lifecycle --------------------------------------------------------
  // Every connection reads the configuration (tried again without end while
  // Gladys cannot give it), then the contracts and the status again.
  gladys.on('connected', () => {
    app
      .connected(() => gladys.getConfig())
      .catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
  });
  gladys.on('disconnected', () => {
    app.disconnected().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  gladys.handleShutdown(() => app.stop());
}
