'use strict';
// Tests for the GitHub Sponsors rail (factory/sprint/license/sponsors.js). GraphQL, auth and storage are mocked.
// Run: node --test factory/sprint/license/test/
// In an extension repo, set ZOVO_SPONSORS_MODULE or copy to test/ and change the path below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MOD = process.env.ZOVO_SPONSORS_MODULE || path.join(__dirname, '..', 'sponsors.js');
const S = require(MOD);

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 9, 2, 0, 0);

// ---------- mocks ----------

function gql({ login = 'buyer', total = 0, sponsorship = null } = {}) {
  return { data: { viewer: { login, totalSponsorshipAmountAsSponsorInCents: total }, user: { sponsorshipForViewerAsSponsor: sponsorship } } };
}
const monthly = (cents = 500) => ({ isActive: true, isOneTimePayment: false, tier: { monthlyPriceInCents: cents, isOneTime: false } });
const pastOneTime = (cents = 1500) => ({ isActive: false, isOneTimePayment: true, tier: { monthlyPriceInCents: cents, isOneTime: true } });

/** fetch mock: each call takes the next answer. An answer is a body object, {status, body}, an Error (throws) or 'hang'. */
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    if (a === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const { status, body } = a && a.status ? a : { status: 200, body: a };
    return { status, ok: status >= 200 && status < 300, json: async () => { if (body === 'not json') throw new SyntaxError('bad'); return body; } };
  };
  fn.calls = calls;
  return fn;
}

function fakeContext({ secretsBroken = false } = {}) {
  const secretMap = new Map();
  const stateMap = new Map();
  const listeners = [];
  return {
    subscriptions: [],
    secretMap,
    stateMap,
    secrets: {
      async get(k) { if (secretsBroken) throw new Error('keychain locked'); return secretMap.get(k); },
      async store(k, v) { if (secretsBroken) throw new Error('keychain locked'); secretMap.set(k, v); listeners.forEach((l) => l({ key: k })); },
      async delete(k) { if (secretsBroken) throw new Error('keychain locked'); secretMap.delete(k); listeners.forEach((l) => l({ key: k })); },
      onDidChange(l) { listeners.push(l); return { dispose() {} }; },
    },
    globalState: {
      get(k) { return stateMap.get(k); },
      async update(k, v) { if (v === undefined) stateMap.delete(k); else stateMap.set(k, v); },
    },
  };
}

function fakeVscode({ token = 'gho_test', cancel = false, silentToken } = {}) {
  const sessionCalls = [];
  const opened = [];
  return {
    sessionCalls,
    opened,
    authentication: {
      async getSession(provider, scopes, options) {
        sessionCalls.push({ provider, scopes, options });
        if (options && options.silent) return silentToken === undefined ? { accessToken: token } : silentToken ? { accessToken: silentToken } : undefined;
        if (cancel) throw new Error('User did not consent to login.');
        return { accessToken: token, account: { label: 'buyer' } };
      },
    },
    env: { async openExternal(uri) { opened.push(uri); return true; } },
    Uri: { parse: (s) => ({ toString: () => s, s }) },
  };
}

function make({ answers = [gql()], ctx = fakeContext(), vs = fakeVscode(), clock = { t: T0 }, timeoutMs } = {}) {
  const f = fakeFetch(...answers);
  const rail = S.createSponsorsRail({ vscode: vs, context: ctx, fetch: f, now: () => clock.t, timeoutMs });
  return { rail, f, ctx, vs, clock };
}

// ---------- pure rules ----------

test('evaluate: lifetime at USD 10 total, monthly when active, none otherwise', () => {
  assert.equal(S.evaluate(gql({ total: 1000 }).data).kind, 'lifetime');
  assert.equal(S.evaluate(gql({ total: 1500, sponsorship: pastOneTime() }).data).kind, 'lifetime');
  assert.equal(S.evaluate(gql({ total: 500, sponsorship: monthly() }).data).kind, 'monthly');
  assert.equal(S.evaluate(gql({ total: 999 }).data).kind, 'none');
  assert.equal(S.evaluate(gql({ total: 500, sponsorship: { ...monthly(), isActive: false } }).data).kind, 'none');
  assert.equal(S.evaluate(gql({ total: 0 }).data).kind, 'none');
  assert.equal(S.evaluate({ viewer: { login: 'x' } }), null);
  assert.equal(S.evaluate(null), null);
  assert.equal(S.evaluate({ viewer: { login: 'x', totalSponsorshipAmountAsSponsorInCents: '1000' } }), null);
});

test('constants match MONEY2 and the brief', () => {
  assert.equal(S.SPONSORABLE, 'theluckystrike');
  assert.equal(S.MIN_TOTAL_CENTS, 1000);
  assert.equal(S.RECHECK_MS, 30 * DAY);
  assert.deepEqual(S.SCOPES, ['read:user']);
  assert.equal(S.GRAPHQL_URL, 'https://api.github.com/graphql');
});

test('nextRecord: errors keep the cache; lifetime never goes down', () => {
  const life = { v: 1, kind: 'lifetime', login: 'a', totalCents: 1500, checkedAt: T0, recheckAt: 0 };
  assert.equal(S.nextRecord(life, { ok: false, reason: 'network' }, T0 + DAY, 'recheck'), life);
  assert.equal(S.nextRecord(life, { ok: true, kind: 'none', login: 'a', totalCents: 0 }, T0 + DAY, 'unlock'), life);
  assert.equal(S.nextRecord(null, { ok: true, kind: 'none', login: 'a', totalCents: 0 }, T0, 'unlock'), null);
  const mon = { v: 1, kind: 'monthly', login: 'a', totalCents: 500, checkedAt: T0, recheckAt: T0 + 30 * DAY };
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'b', totalCents: 0 }, T0 + 31 * DAY, 'recheck'), mon, 'another account says nothing');
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'a', totalCents: 500 }, T0 + DAY, 'unlock'), mon, 'unlock never shortens a paid month');
  assert.equal(S.nextRecord(mon, { ok: true, kind: 'none', login: 'a', totalCents: 500 }, T0 + 31 * DAY, 'recheck'), null);
  const up = S.nextRecord(mon, { ok: true, kind: 'lifetime', login: 'a', totalCents: 1000 }, T0 + 31 * DAY, 'recheck');
  assert.equal(up.kind, 'lifetime');
  assert.equal(up.recheckAt, 0);
});

test('parseRecord: damaged cache is ignored', () => {
  assert.equal(S.parseRecord('{nope'), null);
  assert.equal(S.parseRecord(JSON.stringify({ kind: 'god', login: 'a', checkedAt: 1 })), null);
  assert.equal(S.parseRecord(JSON.stringify({ kind: 'lifetime', login: '', checkedAt: 1 })), null);
  assert.equal(S.parseRecord(undefined), null);
  assert.equal(S.parseRecord(JSON.stringify({ kind: 'lifetime', login: 'a', checkedAt: 1 })).kind, 'lifetime');
});

// ---------- the five cases in the brief ----------

test('active monthly sponsor: Pro for 30 days, recheck date set', async () => {
  const { rail, f } = make({ answers: [gql({ total: 500, sponsorship: monthly() })] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.kind, 'monthly');
  assert.equal(r.message, 'Zovo Pro is on. Thank you.');
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(rail.state().recheckAt, T0 + 30 * DAY);
  assert.equal(f.calls.length, 1);
});

test('past one-time sponsor with USD 10+ total (sponsorship no longer active): Pro for life', async () => {
  const { rail } = make({ answers: [gql({ total: 1500, sponsorship: pastOneTime() })] });
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.kind, 'lifetime');
  assert.equal(rail.state().recheckAt, 0);
  assert.equal(rail.isPro('docx-pro'), true, 'one unlock covers every Zovo sku');
});

test('exactly USD 10 in total is enough', async () => {
  const { rail } = make({ answers: [gql({ total: 1000 })] });
  assert.equal((await rail.unlock()).pro, true);
});

test('below USD 10 and no active monthly: no Pro, says why', async () => {
  const { rail, ctx } = make({ answers: [gql({ total: 500, sponsorship: { ...monthly(), isActive: false } })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'below-minimum');
  assert.match(r.message, /USD 10/);
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size, 0, 'nothing stored for a no');
});

test('not a sponsor: no Pro, message points to the USD 15 tier', async () => {
  const { rail, vs } = make({ answers: [gql({ total: 0 })] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'not-sponsor');
  assert.match(r.message, /USD 15 once/);
  await rail.openSponsorsPage();
  assert.equal(vs.opened[0].s, 'https://github.com/sponsors/theluckystrike?frequency=one-time');
});

test('network error on unlock keeps the cached Pro (never lock a paid user out)', async () => {
  const ctx = fakeContext();
  const first = make({ ctx, answers: [gql({ total: 1500 })] });
  await first.rail.unlock();
  const second = make({ ctx, answers: [new TypeError('fetch failed')] });
  await second.rail.ready;
  assert.equal(second.rail.isPro('hex-pro'), true);
  const r = await second.rail.unlock();
  assert.equal(r.reason, 'network');
  assert.equal(r.pro, true);
  assert.equal(second.rail.isPro('hex-pro'), true);
});

test('network error with no cache: no Pro, nothing stored, nothing thrown', async () => {
  const { rail, ctx } = make({ answers: [new TypeError('fetch failed')] });
  const r = await rail.unlock();
  assert.equal(r.pro, false);
  assert.equal(r.reason, 'network');
  assert.match(r.message, /Nothing changed/);
  assert.equal(ctx.secretMap.size, 0);
});

// ---------- offline, restart, recheck ----------

test('restart offline: Pro comes from SecretStorage with no network and no sign-in', async () => {
  const ctx = fakeContext();
  await make({ ctx, answers: [gql({ total: 1500 })] }).rail.unlock();
  const vs = fakeVscode();
  const { rail, f } = make({ ctx, vs, answers: [new TypeError('offline')] });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(await rail.refresh(), false, 'lifetime is never checked again');
  assert.equal(f.calls.length, 0);
  assert.equal(vs.sessionCalls.length, 0);
});

test('isPro and refresh never show a sign-in; only unlock uses createIfNone', async () => {
  const ctx = fakeContext();
  const vs = fakeVscode();
  const { rail, f } = make({ ctx, vs, answers: [gql({ total: 500, sponsorship: monthly() })] });
  await rail.ready;
  rail.isPro('hex-pro');
  await rail.refresh();
  assert.equal(vs.sessionCalls.length, 0);
  assert.equal(f.calls.length, 0);
  await rail.unlock();
  assert.deepEqual(vs.sessionCalls[0], { provider: 'github', scopes: ['read:user'], options: { createIfNone: true } });
});

test('monthly: no recheck before 30 days', async () => {
  const { rail, f, clock } = make({ answers: [gql({ total: 500, sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 29 * DAY;
  assert.equal(await rail.refresh(), false);
  assert.equal(f.calls.length, 1);
});

test('monthly recheck after 30 days: still active extends 30 days, silently', async () => {
  const vs = fakeVscode();
  const { rail, f, clock } = make({ vs, answers: [gql({ total: 500, sponsorship: monthly() }), gql({ total: 1000, sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  assert.equal(await rail.refresh(), true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(vs.sessionCalls[1].options, { silent: true });
  assert.equal(rail.state().kind, 'lifetime', '2 months of USD 5 = USD 10 = for life');
});

test('monthly recheck: network error keeps Pro and waits a day before the next try', async () => {
  const { rail, f, clock } = make({ answers: [gql({ total: 500, sponsorship: monthly() }), new TypeError('offline')] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  assert.equal(await rail.refresh(), true);
  assert.equal(rail.isPro('hex-pro'), true);
  clock.t += 60 * 60 * 1000;
  assert.equal(await rail.refresh(), false, 'no retry within a day');
  assert.equal(f.calls.length, 2);
});

test('monthly recheck: no silent session keeps Pro, no network', async () => {
  const vs = fakeVscode({ silentToken: null });
  const { rail, f, clock } = make({ vs, answers: [gql({ total: 500, sponsorship: monthly() })] });
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.isPro('hex-pro'), true);
  assert.equal(f.calls.length, 1);
});

test('monthly recheck: GitHub says the same account stopped and paid under USD 10: Pro ends', async () => {
  const { rail, ctx, clock } = make({ answers: [gql({ total: 500, sponsorship: monthly() }), gql({ total: 500, sponsorship: { ...monthly(), isActive: false } })] });
  const seen = [];
  rail.onDidChange((p) => seen.push(p));
  await rail.unlock();
  clock.t = T0 + 31 * DAY;
  await rail.refresh();
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size, 0);
  assert.deepEqual(seen, [true, false]);
});

test('unlock with another, non-sponsor GitHub account does not remove lifetime Pro', async () => {
  const { rail } = make({ answers: [gql({ login: 'a', total: 1500 }), gql({ login: 'b', total: 0 })] });
  await rail.unlock();
  const r = await rail.unlock();
  assert.equal(r.pro, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.note, 'not-sponsor');
  assert.equal(rail.state().login, 'a');
});

// ---------- GitHub errors ----------

test('sign-in cancelled: no network, nothing changes', async () => {
  const { rail, f } = make({ vs: fakeVscode({ cancel: true }) });
  const r = await rail.unlock();
  assert.equal(r.reason, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('401 asks VS Code once for a new session, then reports auth', async () => {
  const vs = fakeVscode();
  const { rail, f } = make({ vs, answers: [{ status: 401, body: {} }] });
  const r = await rail.unlock();
  assert.equal(r.reason, 'auth');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(vs.sessionCalls[1].options, { forceNewSession: true });
});

test('401 then a fresh token that works: unlocked', async () => {
  const { rail } = make({ answers: [{ status: 401, body: {} }, gql({ total: 1500 })] });
  assert.equal((await rail.unlock()).pro, true);
});

test('INSUFFICIENT_SCOPES is reported as scope', async () => {
  const body = { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes" }] };
  const { rail } = make({ answers: [body] });
  assert.equal((await rail.unlock()).reason, 'scope');
});

test('rate limit, 5xx, bad JSON, wrong shape: no Pro change, no throw', async () => {
  for (const [a, reason] of [[{ status: 403, body: {} }, 'rate-limit'], [{ status: 429, body: {} }, 'rate-limit'], [{ status: 502, body: {} }, 'network'], [{ status: 200, body: 'not json' }, 'bad-response'], [{ data: { viewer: null } }, 'bad-response']]) {
    const { rail } = make({ answers: [a] });
    const r = await rail.unlock();
    assert.equal(r.reason, reason, JSON.stringify(a));
    assert.equal(r.pro, false);
  }
});

test('partial GraphQL error (user field failed) still uses the viewer total', async () => {
  const body = { data: { viewer: { login: 'a', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: null }, errors: [{ type: 'NOT_FOUND', message: 'x' }] };
  const { rail } = make({ answers: [body] });
  assert.equal((await rail.unlock()).pro, true);
});

test('timeout counts as a network error', async () => {
  const { rail } = make({ answers: ['hang'], timeoutMs: 30 });
  const r = await rail.unlock();
  assert.equal(r.reason, 'network');
});

// ---------- request, storage, privacy ----------

test('the one request: POST api.github.com/graphql with the token and theluckystrike, nothing else', async () => {
  const { rail, f } = make({ answers: [gql({ total: 1500 })] });
  await rail.unlock();
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.github.com/graphql');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'bearer gho_test');
  assert.deepEqual(c.body.variables, { login: 'theluckystrike' });
  assert.match(c.body.query, /totalSponsorshipAmountAsSponsorInCents\(sponsorableLogins:\[\$login\]\)/);
  assert.match(c.body.query, /sponsorshipForViewerAsSponsor\(activeOnly:false\)/);
  assert.deepEqual(Object.keys(c.body).sort(), ['query', 'variables']);
});

test('the token is never stored', async () => {
  const { rail, ctx } = make({ answers: [gql({ total: 1500 })] });
  await rail.unlock();
  const stored = JSON.stringify([...ctx.secretMap.values(), ...ctx.stateMap.values()]);
  assert.doesNotMatch(stored, /gho_test/);
  assert.deepEqual(Object.keys(JSON.parse(ctx.secretMap.get(S.STORE_KEY))).sort(), ['checkedAt', 'kind', 'login', 'recheckAt', 'totalCents', 'v']);
});

test('keychain not readable: the globalState copy keeps Pro', async () => {
  const ctx = fakeContext();
  await make({ ctx, answers: [gql({ total: 1500 })] }).rail.unlock();
  const broken = fakeContext({ secretsBroken: true });
  for (const [k, v] of ctx.stateMap) broken.stateMap.set(k, v);
  const { rail } = make({ ctx: broken });
  await rail.ready;
  assert.equal(rail.isPro('hex-pro'), true);
});

test('remove() clears both stores and fires the change', async () => {
  const { rail, ctx } = make({ answers: [gql({ total: 1500 })] });
  await rail.unlock();
  const seen = [];
  rail.onDidChange((p) => seen.push(p));
  await rail.remove();
  assert.equal(rail.isPro('hex-pro'), false);
  assert.equal(ctx.secretMap.size + ctx.stateMap.size, 0);
  assert.deepEqual(seen, [false]);
});

test('isPro needs a sku string', async () => {
  const { rail } = make({ answers: [gql({ total: 1500 })] });
  await rail.unlock();
  assert.equal(rail.isPro(''), false);
  assert.equal(rail.isPro(undefined), false);
});

test('source: no telemetry, only the GitHub GraphQL URL and the Sponsors page', () => {
  const src = fs.readFileSync(MOD, 'utf8');
  const urls = [...new Set(src.match(/https?:\/\/[^\s'"`)]+/g))].sort();
  assert.deepEqual(urls, ['https://api.github.com/graphql', 'https://github.com/sponsors/theluckystrike']);
  assert.doesNotMatch(src, /env\.(isTelemetryEnabled|telemetryLevel)|sendTelemetry|createTelemetryLogger|require\(['"](https?|net|dgram)['"]\)/);
});
