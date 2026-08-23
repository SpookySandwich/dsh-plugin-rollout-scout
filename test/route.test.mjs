// Guards on the /rollout-scout route, driven through the real handler.
//
// The route listens on a local port that any page in the browser can reach,
// and its actions start conversations and delete session logs. These tests
// pin the two things that keep a drive-by page from reaching it: a JSON
// content type is required (which forces a CORS preflight that is never
// answered), and a cross-origin `Origin` is refused outright.
//
//   node test/route.test.mjs
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const HOST = '127.0.0.1:5173';

let checks = 0;
let failed = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
}

// Minimal stand-in for the plugin context: `apply` only registers a route.
const routes = [];
apply({
  effect(fn) { routes.push(fn()); },
  webServer: { register(route) { routes.push(route); return route; } },
});
const route = routes.find((r) => r && r.path === '/rollout-scout');
if (route === undefined) {
  console.log('FAIL  apply() did not register the /rollout-scout route');
  process.exit(1);
}

function request({ method = 'GET', headers = {}, body = null }) {
  const stream = body === null
    ? Readable.from([])
    : Readable.from([Buffer.from(body)]);
  stream.method = method;
  stream.headers = { host: HOST, ...headers };
  return stream;
}

function response() {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(text) { out.body = text === undefined ? null : JSON.parse(text); },
  };
}

async function send(options) {
  const res = response();
  await route.handler(request(options), res);
  return res.out;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// -- GET ---------------------------------------------------------------------

let r = await send({ method: 'GET' });
check(r.status === 200 && r.body !== null && 'attempts' in r.body,
  `same-origin GET returns state (${r.status})`);

r = await send({ method: 'GET', headers: { origin: 'https://evil.example' } });
check(r.status === 403, `cross-origin GET refused (${r.status})`);

r = await send({ method: 'GET', headers: { origin: `http://${HOST}` } });
check(r.status === 200, `GET with matching Origin allowed (${r.status})`);

// -- POST content type -------------------------------------------------------
// text/plain is a CORS "simple" content type: a form post from any page would
// use one of these and skip the preflight entirely. It has to be refused.

for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
  r = await send({
    method: 'POST',
    headers: { 'content-type': type },
    body: '{"action":"delete-all"}',
  });
  check(r.status === 415, `POST with ${type} refused (${r.status})`);
}

r = await send({ method: 'POST', body: '{"action":"delete-all"}' });
check(r.status === 415, `POST with no content-type refused (${r.status})`);

r = await send({
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: '{"action":"pause"}',
});
check(r.status === 200, `POST with a charset parameter accepted (${r.status})`);

// -- POST origin -------------------------------------------------------------

r = await send({
  method: 'POST',
  headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
  body: '{"action":"delete-all"}',
});
check(r.status === 403, `cross-origin POST refused before the action runs (${r.status})`);

// -- body handling -----------------------------------------------------------

r = await send({ method: 'POST', headers: JSON_HEADERS, body: '{"action":"nope"}' });
check(r.status === 400, `unknown action is a 400 (${r.status})`);

r = await send({ method: 'POST', headers: JSON_HEADERS, body: 'not json' });
check(r.status === 400, `unparseable body is a 400 (${r.status})`);

r = await send({
  method: 'POST',
  headers: JSON_HEADERS,
  body: `{"action":"start","config":{"prompt":"x","folder":"${'y'.repeat(300 * 1024)}"}}`,
});
check(r.status === 400, `oversized body is refused without launching (${r.status})`);

r = await send({ method: 'PUT', headers: JSON_HEADERS, body: '{}' });
check(r.status === 405, `unsupported method is a 405 (${r.status})`);

// A start with no prompt must not launch anything.
r = await send({ method: 'POST', headers: JSON_HEADERS, body: '{"action":"start","config":{}}' });
check(r.status === 400, `start without a prompt is refused (${r.status})`);

r = await send({ method: 'GET' });
check(r.status === 200 && r.body.running === false && r.body.attempts.length === 0,
  'no probe was launched by any refused request');

r = await send({ method: 'POST', headers: JSON_HEADERS, body: '{"action":"resume"}' });
check(r.status === 409, `resume without a paused run is refused (${r.status})`);

console.log(`\n${checks - failed}/${checks} passed`);
process.exit(failed === 0 ? 0 : 1);
