/**
 * Identifiers are generated on the device, before the first upload attempt,
 * and persisted with the record. That ordering is what makes retries safe:
 * every replay of an upload carries the same Idempotency-Key, so the server
 * can recognise it as the same work rather than new work.
 *
 * Deliberately not a native UUID module. A dependency that must be loaded
 * before the queue can generate an id is a dependency that can fail at the
 * worst possible moment. Collisions need the same millisecond, the same
 * process, the same counter value and 20 matching random characters.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const randomChunk = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
};

/** Stable for the lifetime of the process; distinguishes two runs in one ms. */
const PROCESS_SALT = randomChunk(4);

let counter = 0;

/** `rep_mh2k9a0001x7q3plmz` — matches the server's key charset. */
export function makeId(prefix: string): string {
  counter = (counter + 1) % 0x10000;
  return [
    prefix,
    Date.now().toString(36),
    counter.toString(36).padStart(4, '0'),
    PROCESS_SALT,
    randomChunk(8),
  ].join('_');
}

export const makeReportId = () => makeId('rep');
export const makeImageId = () => makeId('img');
