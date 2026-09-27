// /api/meetings… — moduł domenowy src/pg/meetings.js podpięty do rejestru tras.
// Wstrzykuje serwerowe ładowanie sesji i przydziałów z PostgreSQL.

import { loadAuthorizationContext } from '../authorization.js';
import { handle as handleMeetings } from '../meetings.js';

export const name = 'meetings';

export function handle(request, env, url, json) {
  return handleMeetings(request, { ...env, loadAuthorizationContext }, url, json);
}
