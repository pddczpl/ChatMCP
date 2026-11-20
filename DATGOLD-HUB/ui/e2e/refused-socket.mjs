// What a person reading a red React E2E job needs when the browser reports `net::ERR_NO_BUFFER_SPACE`: that it is the system refusing a port for a new connection (the bind(0) before
// Chromium's connect: WSAENOBUFS on Windows), that nothing in the page did it, and where the evidence is. The error stays an error (the fixture still fails the test); only its message
// says more.
export const REFUSED_SOCKET = 'net::ERR_NO_BUFFER_SPACE';

/** The sentence to add to the failure message when any of the browser's errors is the system refusing a port; an empty string otherwise. */
export function refusedSocketNote(errors) {
  if (!Array.isArray(errors) || !errors.some((error) => String(error).includes(REFUSED_SOCKET))) return '';
  return ` (${REFUSED_SOCKET} is the system refusing a port for a new connection, not the page: it has happened about once in sixty runs on windows-latest, see docs/CI-HEALTH.md, "A port the machine would not give", and test-results/netlog in the artifact)`;
}
