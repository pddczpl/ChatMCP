import test from 'node:test';
import assert from 'node:assert/strict';
import { REFUSED_SOCKET, refusedSocketNote } from '../e2e/refused-socket.mjs';

test('the system refusing a port is named, and the note says where the evidence is', () => {
  const note = refusedSocketNote(['Network: http://127.0.0.1:49900/assets/a.woff2: net::ERR_NO_BUFFER_SPACE', 'Console: Failed to load resource: net::ERR_NO_BUFFER_SPACE']);
  assert.match(note, /net::ERR_NO_BUFFER_SPACE is the system refusing a port for a new connection, not the page/);
  assert.match(note, /docs\/CI-HEALTH\.md, "A port the machine would not give"/);
  assert.match(note, /test-results\/netlog/);
});

test('it is enough that one of several errors is the refusal, and the other errors are still the test\'s to report', () => {
  assert.notEqual(refusedSocketNote(['HTTP 500: http://127.0.0.1:1/api/state', `Network: http://127.0.0.1:1/: ${REFUSED_SOCKET}`]), '');
});

test('any other error, and no error, add nothing', () => {
  assert.equal(refusedSocketNote([]), '');
  assert.equal(refusedSocketNote(['Network: http://127.0.0.1:1/: net::ERR_CONNECTION_REFUSED', 'HTTP 403: http://127.0.0.1:1/api/workspace/select']), '');
  assert.equal(refusedSocketNote(['Runtime: net::ERR_NO_BUFFER']), '');
});

test('a list that is not a list adds nothing and does not throw', () => {
  assert.equal(refusedSocketNote(undefined), '');
  assert.equal(refusedSocketNote(null), '');
  assert.equal(refusedSocketNote('net::ERR_NO_BUFFER_SPACE'), '');
});
