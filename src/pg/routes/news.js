// /api/public/news, /api/news… i /api/news-photos… — moduł domenowy
// src/pg/news.js podpięty do rejestru tras z serwerowym ładowaniem sesji.

import { loadAuthorizationContext, logAccessDenied } from '../authorization.js';
import { handle as handleNews } from '../news.js';

export const name = 'news';

// #184: ślad odmowy 403 `forbidden` zalogowanego aktora. Moduł domenowy woła
// `onAccessDenied` w swoim zewnętrznym `catch` — po zakończeniu (wycofaniu)
// transakcji żądania, więc zdarzenie nie wycofa się razem z nią. Kontekst
// (sesja) pochodzi z tego samego ładowania co bramka modułu.
export function handle(request, env, url, json) {
  let context = null;
  const load = async (req, e) => {
    context = await loadAuthorizationContext(req, e);
    return context;
  };
  const onAccessDenied = () => logAccessDenied(env, context, null, request);
  return handleNews(request, { ...env, loadAuthorizationContext: load, onAccessDenied }, url, json);
}
