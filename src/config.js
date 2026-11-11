// -----------------------------------------------------------------------------
// The configuration typed in Gladys (manifest `config_schema`), normalized so
// that the rest of the code never sees `undefined`. One field: the API key of
// the user (OpenEI / NREL, api.data.gov family), a secret: never logged,
// never in the status, never in /data, never in an address.
// -----------------------------------------------------------------------------

/** An api.data.gov key: 40 letters and digits (DEMO_KEY for a try). Anything else is not sent. */
const KEY = /^[A-Za-z0-9_-]{6,128}$/;

/**
 * @returns {{ apiKey: string, keyProblem: 'missing'|'format'|undefined }}
 * The key is trimmed; a key with a space, a control character or a line
 * break inside is refused here (it would end up in a header), never shown.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const value = typeof source.api_key === 'string' ? source.api_key.trim() : '';
  if (!value) return { apiKey: '', keyProblem: 'missing' };
  if (!KEY.test(value)) return { apiKey: '', keyProblem: 'format' };
  return { apiKey: value, keyProblem: undefined };
}
