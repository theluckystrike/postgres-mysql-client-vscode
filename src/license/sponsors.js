'use strict';
// Zovo Pro, rail 1: GitHub Sponsors (factory/sprint/license/sponsors.js, lane SPON1, 2026-11-09).
// Copied to src/license/sponsors.js in each extension that has Pro features. API: factory/sprint/license/API.md.
//
// What it does:
// - The user clicks "Unlock with GitHub Sponsors". Only then does it call
//   vscode.authentication.getSession('github', ['read:user'], { createIfNone: true }).
// - One GraphQL call to the GitHub GraphQL API (GRAPHQL_URL): the viewer's login, the total the viewer has paid to
//   theluckystrike, and the viewer's sponsorship to theluckystrike (active or past).
// - Pro for life when the total is USD 10 or more (1000 cents). Pro for 30 days when a monthly sponsorship is
//   active, then one recheck (silent, never a sign-in prompt) the next time a Pro feature starts.
// - The result is kept in SecretStorage (a copy of the same small record in globalState is the fallback when the
//   OS keychain is not readable). isPro() reads only that cache: no network.
// - A network error, a timeout, a missing session or a GitHub error never removes Pro that was granted.
//   Only a clear answer from GitHub for the same account ("this monthly sponsorship ended and the total is under
//   USD 10") ends a monthly entitlement. A lifetime entitlement is never checked again.
// - No telemetry. No other network call. The token is used for this one request and never stored by this module.

const RAIL_ID = 'github-sponsors';
const SPONSORABLE = 'theluckystrike';
const SPONSORS_URL = 'https://github.com/sponsors/theluckystrike';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const SCOPES = ['read:user'];
const MIN_TOTAL_CENTS = 1000; // USD 10 paid in total = Pro for life
const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 30 * DAY_MS; // monthly sponsors: recheck after 30 days
const RETRY_MS = DAY_MS; // after a failed recheck, wait a day before the next silent try
const TIMEOUT_MS = 15000;
const STORE_KEY = 'zovo.pro.sponsors.v1';
const KINDS = new Set(['lifetime', 'monthly']);

const QUERY = 'query($login:String!){ viewer { login totalSponsorshipAmountAsSponsorInCents(sponsorableLogins:[$login]) }'
  + ' user(login:$login){ sponsorshipForViewerAsSponsor(activeOnly:false){ isActive isOneTimePayment tier { monthlyPriceInCents isOneTime } } } }';

const MESSAGES = {
  ok: 'Zovo Pro is on. Thank you.',
  'not-sponsor': 'This GitHub account does not sponsor theluckystrike yet. Zovo Pro is USD 15 once on GitHub Sponsors, for all Zovo viewers.',
  'below-minimum': 'Thank you for sponsoring. Zovo Pro needs USD 10 or more in total, or an active monthly sponsorship. The USD 15 one-time tier unlocks it for life.',
  cancelled: 'GitHub sign-in was cancelled. Nothing changed.',
  'no-session': 'No GitHub sign-in. Nothing changed.',
  network: 'GitHub could not be reached. Nothing changed. Try again when you are online.',
  auth: 'GitHub did not accept the sign-in. Sign out of GitHub in the Accounts menu and try again.',
  scope: 'The GitHub sign-in cannot read sponsorships. Sign out of GitHub in the Accounts menu and try again.',
  'rate-limit': 'GitHub is busy. Nothing changed. Try again in a few minutes.',
  'bad-response': 'GitHub sent an answer this version cannot read. Nothing changed.',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Decide the entitlement from the GraphQL `data` object. Pure.
 * @returns {{kind:'lifetime'|'monthly'|'none', login:string, totalCents:number, monthlyActive:boolean}|null}
 *   null when the data does not have the expected shape.
 */
function evaluate(data) {
  const viewer = data && data.viewer;
  if (!viewer || typeof viewer.login !== 'string' || !viewer.login) return null;
  const totalCents = viewer.totalSponsorshipAmountAsSponsorInCents;
  if (!isNum(totalCents)) return null;
  const sp = data.user ? data.user.sponsorshipForViewerAsSponsor : null;
  const monthlyActive = !!(sp && sp.isActive === true && sp.isOneTimePayment !== true && !(sp.tier && sp.tier.isOneTime === true));
  const kind = totalCents >= MIN_TOTAL_CENTS ? 'lifetime' : monthlyActive ? 'monthly' : 'none';
  return { kind, login: viewer.login, totalCents, monthlyActive };
}

/** A stored record, or null when it is missing or damaged. */
function cleanRecord(r) {
  if (!r || typeof r !== 'object' || !KINDS.has(r.kind) || typeof r.login !== 'string' || !r.login) return null;
  if (!isNum(r.checkedAt)) return null;
  return {
    v: 1,
    kind: r.kind,
    login: r.login,
    totalCents: isNum(r.totalCents) ? r.totalCents : 0,
    checkedAt: r.checkedAt,
    recheckAt: r.kind === 'monthly' ? (isNum(r.recheckAt) ? r.recheckAt : r.checkedAt + RECHECK_MS) : 0,
  };
}

function parseRecord(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return cleanRecord(JSON.parse(text)); } catch { return null; }
}

/**
 * The record after a check. Pure.
 * @param {object|null} prev   cached record
 * @param {object} check       {ok:true, kind, login, totalCents} or {ok:false, reason}
 * @param {number} now
 * @param {'unlock'|'recheck'} why
 * @returns {object|null}
 */
function nextRecord(prev, check, now, why) {
  if (!check || !check.ok) return prev; // never lose Pro on an error
  if (prev && prev.kind === 'lifetime' && check.kind !== 'lifetime') return prev; // lifetime never goes down
  if (check.kind === 'lifetime' || check.kind === 'monthly') {
    return { v: 1, kind: check.kind, login: check.login, totalCents: check.totalCents, checkedAt: now, recheckAt: check.kind === 'monthly' ? now + RECHECK_MS : 0 };
  }
  // A clear "no" from GitHub.
  if (!prev) return null;
  if (prev.login !== check.login) return prev; // another GitHub account answered: says nothing about the cached one
  if (why === 'unlock' && now < prev.recheckAt) return prev; // an unlock click never shortens a paid month
  return null; // the monthly sponsorship ended and the total is under USD 10
}

function hasShape(fn) { return typeof fn === 'function'; }

/**
 * Ask GitHub once. Never throws.
 * @returns {Promise<{ok:true, kind, login, totalCents, monthlyActive}|{ok:false, reason:string}>}
 */
async function queryGitHub(token, { fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, reason: 'network' };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await f(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'zovo-vscode-pro' },
        body: JSON.stringify({ query: QUERY, variables: { login: SPONSORABLE } }),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'bad-response' };
    if (res.status === 401) return { ok: false, reason: 'auth' };
    if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate-limit' };
    if (res.status >= 500 || res.status === 408) return { ok: false, reason: 'network' };
    if (res.status !== 200) return { ok: false, reason: 'bad-response' };
    let body;
    try { body = await res.json(); } catch { return { ok: false, reason: ctrl && ctrl.signal.aborted ? 'network' : 'bad-response' }; }
    if (body && Array.isArray(body.errors) && body.errors.length) {
      const scope = body.errors.some((e) => e && (e.type === 'INSUFFICIENT_SCOPES' || /scope/i.test(String(e.message || ''))));
      // A partial answer with a usable viewer total is still an answer (the user field can fail on its own).
      const partial = evaluate(body.data);
      if (partial && !scope) return { ok: true, ...partial };
      return { ok: false, reason: scope ? 'scope' : 'bad-response' };
    }
    const r = evaluate(body && body.data);
    return r ? { ok: true, ...r } : { ok: false, reason: 'bad-response' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create the GitHub Sponsors rail.
 * @param {{vscode?:object, context:object, fetch?:Function, now?:()=>number, timeoutMs?:number}} opts
 */
function createSponsorsRail(opts) {
  const vscode = opts.vscode || require('vscode'); // eslint-disable-line global-require
  const { context } = opts;
  const now = opts.now || Date.now;
  const fetchImpl = opts.fetch;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const secrets = context.secrets;
  const gstate = context.globalState;
  const listeners = new Set();
  let record = null;
  let lastAttemptAt = 0;
  let busy = null;
  let writing = 0; // our own SecretStorage writes in flight: ignore their change events

  const pro = () => !!record;
  function fire(before) {
    if (before === pro()) return;
    for (const l of [...listeners]) { try { l(pro()); } catch { /* a listener error must not break the rail */ } }
  }

  // initial: true at start-up. A missing secret then falls back to the globalState copy (keychain reset) and
  // restores the secret. On a change event from another window only the secret counts, so a removal sticks.
  async function readStore(initial) {
    let fromSecret = null;
    let secretOk = true;
    try { fromSecret = parseRecord(await secrets.get(STORE_KEY)); } catch { secretOk = false; }
    if (fromSecret) return fromSecret;
    if (secretOk && !initial) return null;
    let fromState = null;
    try { fromState = cleanRecord(gstate.get(STORE_KEY)); } catch { fromState = null; }
    if (fromState && secretOk) {
      writing++;
      try { await secrets.store(STORE_KEY, JSON.stringify(fromState)); } catch { /* keychain off: globalState still has it */ } finally { writing--; }
    }
    return fromState;
  }

  // globalState first on removal, so a change event can never bring a removed record back.
  async function writeStore(r) {
    writing++;
    try {
      if (r) {
        try { await gstate.update(STORE_KEY, r); } catch { /* ignore */ }
        try { await secrets.store(STORE_KEY, JSON.stringify(r)); } catch { /* globalState copy is the fallback */ }
      } else {
        try { await gstate.update(STORE_KEY, undefined); } catch { /* ignore */ }
        try { await secrets.delete(STORE_KEY); } catch { /* ignore */ }
      }
    } finally { writing--; }
  }

  async function load(initial) {
    const r = await readStore(initial);
    const before = pro();
    record = r;
    fire(before);
  }

  const ready = load(true);

  // Another window of the same extension unlocked or removed: follow it.
  if (secrets && hasShape(secrets.onDidChange)) {
    const sub = secrets.onDidChange((e) => { if (writing === 0 && (!e || e.key === STORE_KEY)) load(false); });
    if (context.subscriptions && sub) context.subscriptions.push(sub);
  }

  async function getSession(interactive, forceNew) {
    const options = forceNew ? { forceNewSession: true } : interactive ? { createIfNone: true } : { silent: true };
    try {
      const s = await vscode.authentication.getSession('github', SCOPES, options);
      return s && s.accessToken ? { session: s } : { reason: 'no-session' };
    } catch {
      return { reason: interactive ? 'cancelled' : 'no-session' };
    }
  }

  async function apply(check, why) {
    const before = pro();
    const next = nextRecord(record, check, now(), why);
    if (next !== record) { record = next; await writeStore(next); }
    fire(before);
  }

  function result(reason, check) {
    return { rail: RAIL_ID, pro: pro(), reason, kind: record ? record.kind : 'none', login: (check && check.login) || (record && record.login) || '', message: MESSAGES[reason] };
  }

  /**
   * Unlock: the only place that may show the GitHub sign-in. Call it from the user's click.
   * @returns {Promise<{rail:string, pro:boolean, reason:string, kind:string, login:string, message:string}>}
   */
  async function unlock() {
    await ready;
    let got = await getSession(true, false);
    if (!got.session) return result(got.reason);
    let check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
    if (!check.ok && (check.reason === 'auth' || check.reason === 'scope')) {
      // A stale or narrow token: ask VS Code for a fresh one once (the user is in the flow already).
      got = await getSession(true, true);
      if (!got.session) return result(got.reason);
      check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
    }
    lastAttemptAt = now();
    await apply(check, 'unlock');
    if (!check.ok) return result(check.reason);
    if (check.kind === 'none') {
      const reason = check.totalCents > 0 ? 'below-minimum' : 'not-sponsor';
      return pro() ? { ...result('ok', check), note: reason } : result(reason, check);
    }
    return result('ok', check);
  }

  /**
   * Silent recheck for a monthly entitlement whose 30 days are over. Never prompts. Does nothing (no network)
   * for lifetime, for no entitlement, before the recheck date, or within a day of a failed try.
   * Call it when the user starts a Pro feature, without awaiting it.
   * @returns {Promise<boolean>} true when it asked GitHub
   */
  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      await ready;
      const t = now();
      if (!record || record.kind !== 'monthly' || t < record.recheckAt || t - lastAttemptAt < RETRY_MS) return false;
      lastAttemptAt = t;
      const got = await getSession(false, false);
      if (!got.session) return true; // no silent session: keep Pro, try again tomorrow
      const check = await queryGitHub(got.session.accessToken, { fetchImpl, timeoutMs });
      await apply(check, 'recheck');
      return true;
    })().finally(() => { busy = null; });
    return busy;
  }

  return {
    id: RAIL_ID,
    ready,
    /** Pro for any Zovo sku. Reads the cache only. Before `ready` resolves it is false. */
    isPro(sku) { return typeof sku === 'string' && sku.length > 0 && pro(); },
    unlock,
    refresh,
    /** "Remove license": forget the cached entitlement on this machine. */
    async remove() { await ready; const before = pro(); record = null; await writeStore(null); fire(before); },
    /** A copy of the cached record (no token), or null. */
    state() { return record ? { ...record } : null; },
    /** listener(pro:boolean) when Pro turns on or off. Returns a disposable. */
    onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    /** Open the GitHub Sponsors page (user click only). */
    openSponsorsPage() { return vscode.env.openExternal(vscode.Uri.parse(`${SPONSORS_URL}?frequency=one-time`)); },
  };
}

module.exports = {
  createSponsorsRail,
  evaluate,
  nextRecord,
  queryGitHub,
  parseRecord,
  RAIL_ID,
  SPONSORABLE,
  SPONSORS_URL,
  GRAPHQL_URL,
  SCOPES,
  MIN_TOTAL_CENTS,
  RECHECK_MS,
  RETRY_MS,
  STORE_KEY,
  QUERY,
  MESSAGES,
};
