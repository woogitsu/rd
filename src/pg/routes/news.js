// /api/public/news, /api/news… i /api/news-photos… — moduł domenowy
// src/pg/news.js podpięty do rejestru tras z serwerowym ładowaniem sesji.

import { loadAuthorizationContext } from '../authorization.js';
import { handle as handleNews } from '../news.js';

export const name = 'news';

export function handle(request, env, url, json) {
  return handleNews(request, { ...env, loadAuthorizationContext }, url, json);
}
