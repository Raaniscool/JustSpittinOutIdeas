/**
 * Re-export of the shared scoring module.
 * Server code imports from here; the browser imports shared/scoring.js directly.
 * One implementation, so the number in the API and the colour in the UI always agree.
 */
export * from '../../../shared/scoring.js';
