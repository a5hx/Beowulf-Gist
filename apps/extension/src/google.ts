const TLDS = ['com', 'co.uk', 'co.in', 'ca', 'com.au', 'de', 'fr', 'es', 'it', 'nl', 'co.jp', 'com.br', 'ie', 'co.nz', 'com.sg'];

export const GOOGLE_MATCHES = TLDS.map((t) => `https://www.google.${t}/search*`);

/** Web results only: no Images/News/Shopping tabs (tbm=…), and only the default or "Web" (udm=14) view. */
export function isWebSearch(url: URL): boolean {
  if (url.pathname !== '/search' || url.searchParams.has('tbm')) return false;
  const udm = url.searchParams.get('udm');
  return udm === null || udm === '14';
}
