// api.sssng.online → the API on Render (greatprofessor12 account).
// The custom domain is still registered to a service in another Render account, so instead of a
// CNAME this Worker forwards every request to the Render service's own address.
const ORIGIN = 'https://sss-api-ee8e.onrender.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('x-forwarded-for', ip);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    return fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  },
};
