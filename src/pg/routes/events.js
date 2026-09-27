// /api/events… — moduł domenowy src/pg/events.js podpięty do rejestru tras.
// Wstrzykuje serwerowe ładowanie sesji i przydziałów z PostgreSQL.

import { loadAuthorizationContext } from '../authorization.js';
import { handle as handleEvents } from '../events.js';

export const name = 'events';

export function handle(request, env, url, json) {
  return handleEvents(request, { ...env, loadAuthorizationContext }, url, json);
}
