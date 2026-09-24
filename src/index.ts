interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * CTA MCP — Chicago Transit Authority real-time trains ('L') + buses
 *
 * Tools:
 * - cta_train_arrivals: upcoming 'L' trains at a station (Train Tracker ttarrivals)
 * - cta_train_positions: live trains on one or more lines (ttpositions)
 * - cta_bus_predictions: bus arrival predictions at a stop (Bus Tracker getpredictions),
 *   with a find_stop text lookup (getdirections + getstops) when the stop id is unknown
 * - cta_bus_positions: live buses on a route (getvehicles)
 *
 * Auth: combined credential. `_apiKey` = "train_key:bus_key" (split on the FIRST
 * colon) — Train Tracker key from transitchicago.com/developers, Bus Tracker key
 * from ctabustracker.com. The gateway injects PLATFORM_CTA_KEY.
 *
 * API quirks:
 * - Train times (arrT/prdt) are "yyyy-MM-ddTHH:mm:ss" wall-clock in America/Chicago
 *   with no offset — minutes_away is computed against Chicago "now" via Intl.
 * - Train errors come back HTTP 200 as ctatt.errCd != "0" with errNm text.
 * - Bus timestamps are "yyyyMMdd HH:mm" (also Chicago local); predictions carry a
 *   ready-made countdown `prdctdn` ("3", or "DUE" when imminent, "DLY" when delayed).
 * - Bus errors come back HTTP 200 as bustime-response.error[].msg (e.g. "No service
 *   scheduled", "No arrival times", "Invalid API access key supplied"). No-data
 *   messages are surfaced as a note; auth failures throw.
 * - Station names are ambiguous ("Western" exists on 5 lines / 5 stations) — the
 *   embedded table (144 stations from the City of Chicago "CTA L System Information"
 *   dataset, resource 8pix-ypme, fetched 2026-07-19) disambiguates via the route
 *   filter, else errors with the candidates.
 */


const TRAIN_BASE = 'https://lapi.transitchicago.com/api/1.0';
const BUS_BASE = 'https://www.ctabustracker.com/bustime/api/v2';
const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Embedded 'L' station table: [mapid, name, lines]
// Source: data.cityofchicago.org resource 8pix-ypme (302 stop rows → 144 stations),
// embedded at build time so station names resolve without a runtime dependency.

const STATIONS: Array<[string, string, string]> = [
  ['40830', '18th', 'Pink'],
  ['41120', '35th-Bronzeville-IIT', 'G'],
  ['40120', '35th/Archer', 'Org'],
  ['41270', '43rd', 'G'],
  ['41080', '47th', 'G'],
  ['41230', '47th', 'Red'],
  ['40130', '51st', 'G'],
  ['40580', '54th/Cermak', 'Pink'],
  ['40910', '63rd', 'Red'],
  ['40990', '69th', 'Red'],
  ['40240', '79th', 'Red'],
  ['41430', '87th', 'Red'],
  ['40450', '95th/Dan Ryan', 'Red'],
  ['40680', 'Adams/Wabash', 'Brn,G,Org,P,Pink'],
  ['41420', 'Addison', 'Red'],
  ['41440', 'Addison', 'Brn'],
  ['41240', 'Addison', 'Blue'],
  ['41200', 'Argyle', 'Red'],
  ['40660', 'Armitage', 'Brn,P'],
  ['40170', 'Ashland', 'G,Pink'],
  ['41060', 'Ashland', 'Org'],
  ['40290', 'Ashland/63rd', 'G'],
  ['40010', 'Austin', 'Blue'],
  ['41260', 'Austin', 'G'],
  ['40060', 'Belmont', 'Blue'],
  ['41320', 'Belmont', 'Red,Brn,P'],
  ['40340', 'Berwyn', 'Red'],
  ['41380', 'Bryn Mawr', 'Red'],
  ['41360', 'California', 'G'],
  ['40570', 'California', 'Blue'],
  ['40440', 'California', 'Pink'],
  ['40280', 'Central', 'G'],
  ['41250', 'Central', 'P'],
  ['40780', 'Central Park', 'Pink'],
  ['41000', 'Cermak-Chinatown', 'Red'],
  ['41690', 'Cermak-McCormick Place', 'G'],
  ['41450', 'Chicago', 'Red'],
  ['40710', 'Chicago', 'Brn,P'],
  ['41410', 'Chicago', 'Blue'],
  ['40970', 'Cicero', 'Blue'],
  ['40480', 'Cicero', 'G'],
  ['40420', 'Cicero', 'Pink'],
  ['40630', 'Clark/Division', 'Red'],
  ['40380', 'Clark/Lake', 'Blue,Brn,G,Org,P,Pink'],
  ['41160', 'Clinton', 'G,Pink'],
  ['40430', 'Clinton', 'Blue'],
  ['41670', 'Conservatory', 'G'],
  ['40720', 'Cottage Grove', 'G'],
  ['40230', 'Cumberland', 'Blue'],
  ['40590', 'Damen', 'Blue'],
  ['41710', 'Damen', 'G'],
  ['40210', 'Damen', 'Pink'],
  ['40090', 'Damen', 'Brn'],
  ['40050', 'Davis', 'P'],
  ['40690', 'Dempster', 'P'],
  ['40140', 'Dempster-Skokie', 'Y'],
  ['40530', 'Diversey', 'Brn,P'],
  ['40320', 'Division', 'Blue'],
  ['40390', 'Forest Park', 'Blue'],
  ['40520', 'Foster', 'P'],
  ['40870', 'Francisco', 'Brn'],
  ['41220', 'Fullerton', 'Red,Brn,P'],
  ['41170', 'Garfield', 'Red'],
  ['40510', 'Garfield', 'G'],
  ['40330', 'Grand', 'Red'],
  ['40490', 'Grand', 'Blue'],
  ['40760', 'Granville', 'Red'],
  ['40940', 'Halsted', 'G'],
  ['41130', 'Halsted', 'Org'],
  ['40980', 'Harlem', 'Blue'],
  ['40750', 'Harlem', 'Blue'],
  ['40020', 'Harlem/Lake', 'G'],
  ['40850', 'Harold Washington Library-State/Van Buren', 'Brn,Org,P,Pink'],
  ['41490', 'Harrison', 'Red'],
  ['40900', 'Howard', 'Red,P,Y'],
  ['40810', 'Illinois Medical District', 'Blue'],
  ['40300', 'Indiana', 'G'],
  ['40550', 'Irving Park', 'Blue'],
  ['41460', 'Irving Park', 'Brn'],
  ['40070', 'Jackson', 'Blue'],
  ['40560', 'Jackson', 'Red'],
  ['41190', 'Jarvis', 'Red'],
  ['41280', 'Jefferson Park', 'Blue'],
  ['41150', 'Kedzie', 'Org'],
  ['41070', 'Kedzie', 'G'],
  ['41040', 'Kedzie', 'Pink'],
  ['41180', 'Kedzie', 'Brn'],
  ['40250', 'Kedzie-Homan', 'Blue'],
  ['41290', 'Kimball', 'Brn'],
  ['41140', 'King Drive', 'G'],
  ['40600', 'Kostner', 'Pink'],
  ['41660', 'Lake', 'Red'],
  ['40700', 'Laramie', 'G'],
  ['41340', 'LaSalle', 'Blue'],
  ['40160', 'LaSalle/Van Buren', 'Brn,Org,P,Pink'],
  ['40770', 'Lawrence', 'Red'],
  ['41050', 'Linden', 'P'],
  ['41020', 'Logan Square', 'Blue'],
  ['41300', 'Loyola', 'Red'],
  ['40270', 'Main', 'P'],
  ['40460', 'Merchandise Mart', 'Brn,P'],
  ['40930', 'Midway', 'Org'],
  ['41090', 'Monroe', 'Red'],
  ['40790', 'Monroe', 'Blue'],
  ['41330', 'Montrose', 'Blue'],
  ['41500', 'Montrose', 'Brn'],
  ['41510', 'Morgan', 'G,Pink'],
  ['40100', 'Morse', 'Red'],
  ['40650', 'North/Clybourn', 'Red'],
  ['40400', 'Noyes', 'P'],
  ['40890', 'O\'Hare', 'Blue'],
  ['41350', 'Oak Park', 'G'],
  ['40180', 'Oak Park', 'Blue'],
  ['41680', 'Oakton-Skokie', 'Y'],
  ['41310', 'Paulina', 'Brn'],
  ['41030', 'Polk', 'Pink'],
  ['40030', 'Pulaski', 'G'],
  ['40920', 'Pulaski', 'Blue'],
  ['40150', 'Pulaski', 'Pink'],
  ['40960', 'Pulaski', 'Org'],
  ['40040', 'Quincy/Wells', 'Brn,Org,P,Pink'],
  ['40470', 'Racine', 'Blue'],
  ['40610', 'Ridgeland', 'G'],
  ['41010', 'Rockwell', 'Brn'],
  ['41400', 'Roosevelt', 'Red,G,Org'],
  ['40820', 'Rosemont', 'Blue'],
  ['40800', 'Sedgwick', 'Brn,P'],
  ['40080', 'Sheridan', 'Red'],
  ['40840', 'South Boulevard', 'P'],
  ['40360', 'Southport', 'Brn'],
  ['40190', 'Sox-35th', 'Red'],
  ['40260', 'State/Lake', 'Brn,G,Org,P,Pink'],
  ['40880', 'Thorndale', 'Red'],
  ['40350', 'UIC-Halsted', 'Blue'],
  ['40370', 'Washington', 'Blue'],
  ['41700', 'Washington/Wabash', 'Brn,G,Org,P,Pink'],
  ['40730', 'Washington/Wells', 'Brn,Org,P,Pink'],
  ['41210', 'Wellington', 'Brn,P'],
  ['41480', 'Western', 'Brn'],
  ['40670', 'Western', 'Blue'],
  ['40220', 'Western', 'Blue'],
  ['40310', 'Western', 'Org'],
  ['40740', 'Western', 'Pink'],
  ['40540', 'Wilson', 'Red,P'],
];

// ---------------------------------------------------------------------------
// Line-name normalization: full color names → Train Tracker route codes

const LINE_CODES: Record<string, string> = {
  red: 'Red',
  blue: 'Blue',
  brown: 'Brn',
  brn: 'Brn',
  green: 'G',
  g: 'G',
  orange: 'Org',
  org: 'Org',
  purple: 'P',
  p: 'P',
  pink: 'Pink',
  pnk: 'Pink',
  yellow: 'Y',
  y: 'Y',
};

const LINE_LABELS: Record<string, string> = {
  Red: 'Red',
  Blue: 'Blue',
  Brn: 'Brown',
  G: 'Green',
  Org: 'Orange',
  P: 'Purple',
  Pink: 'Pink',
  Y: 'Yellow',
};

function toLineCode(input: string): string {
  const key = input.trim().toLowerCase().replace(/\s*line$/, '');
  const code = LINE_CODES[key];
  if (!code) {
    throw new Error(
      `CTA: unknown 'L' line "${input}". Valid lines: Red, Blue, Brown, Green, Orange, Purple, Pink, Yellow.`,
    );
  }
  return code;
}

// ---------------------------------------------------------------------------
// Station name resolution

/** Normalize a station name/query: lowercase, drop "and"/"&"/"/" and punctuation. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+(station|stop)\s*$/, '')
    .replace(/\band\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

interface Station {
  mapid: string;
  name: string;
  lines: string[];
}

function stationList(): Station[] {
  return STATIONS.map(([mapid, name, lines]) => ({ mapid, name, lines: lines.split(',') }));
}

/** Resolve station name or mapid → station(s); routeCode disambiguates duplicates. */
function resolveStation(input: string, routeCode?: string): Station {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('CTA: station is required — pass a station name like "Belmont" or "Clark/Lake", or a numeric mapid like 41320.');
  }
  if (/^4\d{4}$/.test(raw)) {
    const known = stationList().find((s) => s.mapid === raw);
    return known ?? { mapid: raw, name: raw, lines: [] };
  }

  const q = normName(raw);
  if (!q) throw new Error(`CTA: could not parse station "${input}".`);
  const all = stationList();

  let matches = all.filter((s) => normName(s.name) === q);
  if (matches.length === 0) matches = all.filter((s) => normName(s.name).startsWith(q));
  if (matches.length === 0) matches = all.filter((s) => normName(s.name).includes(q));
  if (matches.length === 0) {
    throw new Error(
      `CTA: no 'L' station matched "${input}". Pass a station name (e.g. "Belmont", "Clark/Lake", "O'Hare") or a 5-digit mapid. For bus stops use cta_bus_predictions instead.`,
    );
  }

  if (matches.length > 1 && routeCode) {
    const onLine = matches.filter((s) => s.lines.includes(routeCode));
    if (onLine.length >= 1) matches = onLine;
  }
  if (matches.length > 1) {
    // Distinct stations sharing a name (e.g. Western ×5). Same name+lines → take first.
    const opts = matches
      .map((s) => `${s.name} (mapid ${s.mapid}, ${s.lines.map((l) => LINE_LABELS[l] ?? l).join('/')} Line)`)
      .join('; ');
    throw new Error(
      `CTA: "${input}" matches multiple 'L' stations: ${opts}. Pass the mapid, or add a route (line color) to disambiguate.`,
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Time helpers — Train Tracker times are Chicago wall-clock with no UTC offset.

/** Chicago "now" as a pseudo-UTC epoch, comparable with Date.parse(wallTime + 'Z'). */
function chicagoNowMs(): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const h = get('hour') === '24' ? '00' : get('hour');
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T${h}:${get('minute')}:${get('second')}Z`);
}

/** Minutes from Chicago-now until a "yyyy-MM-ddTHH:mm:ss" Chicago wall time. */
function minutesAway(wallTime: string): number | null {
  const t = Date.parse(`${wallTime}Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - chicagoNowMs()) / 60000));
}

// ---------------------------------------------------------------------------
// Credential + fetch plumbing

function splitKeys(args: Record<string, unknown>): { trainKey: string; busKey: string } {
  const combined = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  delete args._apiKey;
  const idx = combined.indexOf(':');
  const trainKey = idx > 0 ? combined.slice(0, idx).trim() : '';
  const busKey = idx > 0 ? combined.slice(idx + 1).trim() : '';
  if (!trainKey || !busKey) {
    throw new Error(
      'CTA requires a combined credential as "train_key:bus_key" — a Train Tracker API key (free signup at transitchicago.com/developers) and a Bus Tracker API key (free signup at ctabustracker.com), joined by a colon. Pass it via _apiKey, or [sign up](https://pipeworx.io/signup?via=auth_hint) to use the platform credentials.',
    );
  }
  return { trainKey, busKey };
}

async function timedFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`CTA API timeout after ${TIMEOUT_MS / 1000}s — the upstream tracker is slow right now, retry shortly.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// One item vs array is inconsistent in the Train Tracker JSON — normalize.
function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

interface Ctatt {
  tmst?: string;
  errCd?: string;
  errNm?: string | null;
  [k: string]: unknown;
}

async function trainApi(endpoint: string, params: Record<string, string>, trainKey: string): Promise<Ctatt> {
  const qs = new URLSearchParams({ key: trainKey, ...params, outputType: 'JSON' });
  const res = await timedFetch(`${TRAIN_BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw await httpError(res, 'CTA Train Tracker');
  const data = (await res.json()) as { ctatt?: Ctatt };
  const ctatt = data.ctatt ?? {};
  if (ctatt.errCd && ctatt.errCd !== '0') {
    const nm = ctatt.errNm ?? `error ${ctatt.errCd}`;
    if (/api key/i.test(String(nm))) {
      throw new Error(
        `CTA Train Tracker: ${nm}. The train half of the "train_key:bus_key" credential is invalid — free keys at transitchicago.com/developers.`,
      );
    }
    throw new Error(`CTA Train Tracker: ${nm}`);
  }
  return ctatt;
}

interface BustimeResponse {
  error?: Array<{ msg?: string; rt?: string; stpid?: string }>;
  [k: string]: unknown;
}

async function busApi(endpoint: string, params: Record<string, string>, busKey: string): Promise<BustimeResponse> {
  const qs = new URLSearchParams({ key: busKey, ...params, format: 'json' });
  const res = await timedFetch(`${BUS_BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw await httpError(res, 'CTA Bus Tracker');
  const data = (await res.json()) as { 'bustime-response'?: BustimeResponse };
  const body = data['bustime-response'] ?? {};
  const errs = body.error ?? [];
  if (errs.some((e) => /api access key/i.test(e.msg ?? ''))) {
    throw new Error(
      'CTA Bus Tracker: invalid API key. The bus half of the "train_key:bus_key" credential is invalid — free keys at ctabustracker.com.',
    );
  }
  return body;
}

/** Human-readable summary of bustime-response.error[] (no-data style messages). */
function busErrorNote(body: BustimeResponse): string | undefined {
  const errs = body.error ?? [];
  if (errs.length === 0) return undefined;
  return errs
    .map((e) => `${e.msg ?? 'error'}${e.stpid ? ` (stop ${e.stpid})` : e.rt ? ` (route ${e.rt})` : ''}`)
    .join('; ');
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
}

// ---------------------------------------------------------------------------
// Tool definitions

const KEY_DESC =
  'Optional: your own CTA credentials as "train_key:bus_key" — Train Tracker key (free at transitchicago.com/developers) + Bus Tracker key (free at ctabustracker.com)';

const tools: McpToolExport['tools'] = [
  {
    name: 'cta_train_arrivals',
    description:
      'Real-time Chicago CTA \'L\' train arrivals at a station — answers "when is the next train Chicago", next Red Line at Belmont, Blue Line to O\'Hare from Clark/Lake. Returns each upcoming train\'s line color, destination, arrival time and minutes_away, plus approaching / delayed / scheduled-only flags and the platform description. Station accepts a name ("Belmont", "Clark/Lake", "O\'Hare") or a 5-digit mapid (e.g. 41320). Example: cta_train_arrivals({ station: "Belmont", route: "Red" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description: 'Station name (e.g. "Belmont", "Clark/Lake", "O\'Hare", "Midway") or 5-digit mapid (e.g. "41320")',
        },
        route: {
          type: 'string',
          description: 'Optional \'L\' line filter: Red, Blue, Brown, Green, Orange, Purple, Pink, or Yellow (also disambiguates same-named stations)',
        },
        max: { type: 'number', description: 'Max arrivals to return, 1-20 (default 8)' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
      required: ['station'],
    },
  },
  {
    name: 'cta_train_positions',
    description:
      'Live Chicago CTA \'L\' train positions on one or more lines — where every Red Line, Blue Line, Brown, Green, Orange, Purple, Pink, or Yellow train is right now: lat/lon, heading, next station with ETA, destination, approaching and delayed flags. Answers "where are the Blue Line trains" for the Chicago L. Example: cta_train_positions({ routes: "Red,Blue" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        routes: {
          type: 'string',
          description: 'Comma-separated \'L\' lines, full color names accepted: "Red", "Red,Blue", "Brown,Purple"',
        },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
      required: ['routes'],
    },
  },
  {
    name: 'cta_bus_predictions',
    description:
      'Chicago CTA bus tracker arrival predictions at a bus stop — route, destination, predicted minutes until arrival ("DUE" = arriving now), delay flag, and vehicle id. Pass stop_id (the 4-5 digit stop number posted on CTA bus-stop signs), optionally with route. If you only know the stop by name, pass route + find_stop (a street/intersection fragment like "clark & madison") and the stop is looked up for you. Example: cta_bus_predictions({ route: "22", find_stop: "addison" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        stop_id: {
          type: 'string',
          description: 'CTA bus stop id (stpid), the number on the bus-stop sign, e.g. "1926". Comma-separable up to 10.',
        },
        route: {
          type: 'string',
          description: 'Optional bus route number to filter, e.g. "22", "66", "X49". Required when using find_stop.',
        },
        find_stop: {
          type: 'string',
          description: 'Stop-name fragment to look up when stop_id is unknown, e.g. "clark & madison", "michigan & randolph". Requires route.',
        },
        direction: {
          type: 'string',
          description: 'Optional direction to narrow find_stop, e.g. "Northbound", "south"',
        },
        max: { type: 'number', description: 'Max predictions to return, 1-20 (default 10)' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
    },
  },
  {
    name: 'cta_bus_positions',
    description:
      'Live Chicago CTA bus positions on a route — every vehicle currently running: lat/lon, heading, destination, delayed flag, and distance along the pattern. Answers "where is the 22 Clark bus right now" via the CTA bus tracker. Example: cta_bus_positions({ route: "22" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        route: { type: 'string', description: 'Bus route number, e.g. "22", "66", "146". Comma-separable up to 10.' },
        _apiKey: { type: 'string', description: KEY_DESC },
      },
      required: ['route'],
    },
  },
];

// ---------------------------------------------------------------------------
// cta_train_arrivals

interface RawEta {
  staId: string;
  stpId: string;
  staNm: string;
  stpDe: string;
  rn: string;
  rt: string;
  destNm: string;
  prdt: string;
  arrT: string;
  isApp: string;
  isSch: string;
  isDly: string;
  lat?: string | null;
  lon?: string | null;
}

async function trainArrivals(args: Record<string, unknown>, trainKey: string) {
  const routeCode = args.route ? toLineCode(String(args.route)) : undefined;
  const station = resolveStation(String(args.station ?? ''), routeCode);
  const max = clampNum(args.max, 8, 1, 20);

  const params: Record<string, string> = { mapid: station.mapid, max: String(max) };
  if (routeCode) params.rt = routeCode;
  const ctatt = await trainApi('ttarrivals.aspx', params, trainKey);

  const etas = toArray(ctatt.eta as RawEta | RawEta[]).map((e) => ({
    line: LINE_LABELS[e.rt] ?? e.rt,
    run_number: e.rn,
    destination: e.destNm,
    platform: e.stpDe, // e.g. "Service toward Loop"
    arrival_time: e.arrT,
    minutes_away: minutesAway(e.arrT),
    approaching: e.isApp === '1',
    delayed: e.isDly === '1',
    scheduled_only: e.isSch === '1', // true = timetable, not a live-tracked train
  }));

  return {
    station: station.name,
    mapid: station.mapid,
    lines: station.lines.map((l) => LINE_LABELS[l] ?? l),
    generated_at: ctatt.tmst,
    count: etas.length,
    note:
      etas.length === 0
        ? 'No upcoming trains reported for this station right now (service may have ended, or check the route filter).'
        : undefined,
    arrivals: etas,
  };
}

// ---------------------------------------------------------------------------
// cta_train_positions

interface RawTrain {
  rn: string;
  destNm: string;
  nextStaNm: string;
  arrT: string;
  isApp: string;
  isDly: string;
  lat: string;
  lon: string;
  heading: string;
}

async function trainPositions(args: Record<string, unknown>, trainKey: string) {
  const routesInput = String(args.routes ?? args.route ?? '').trim();
  if (!routesInput) {
    throw new Error('cta_train_positions requires routes, e.g. { routes: "Red" } or { routes: "Red,Blue" }.');
  }
  const codes = routesInput.split(',').map(toLineCode);
  const ctatt = await trainApi('ttpositions.aspx', { rt: codes.join(',') }, trainKey);

  const routes = toArray(ctatt.route as Record<string, unknown> | Record<string, unknown>[]).map((r) => {
    const code = String(r['@name'] ?? r.name ?? '');
    const codeKey = Object.keys(LINE_LABELS).find((k) => k.toLowerCase() === code.toLowerCase()) ?? code;
    const trains = toArray(r.train as RawTrain | RawTrain[]).map((t) => ({
      run_number: t.rn,
      destination: t.destNm,
      next_station: t.nextStaNm,
      next_arrival_time: t.arrT,
      next_arrival_minutes: minutesAway(t.arrT),
      approaching: t.isApp === '1',
      delayed: t.isDly === '1',
      latitude: Number(t.lat),
      longitude: Number(t.lon),
      heading_degrees: Number(t.heading),
    }));
    return { line: LINE_LABELS[codeKey] ?? code, train_count: trains.length, trains };
  });

  return {
    generated_at: ctatt.tmst,
    routes,
    note: routes.every((r) => r.train_count === 0)
      ? 'No trains currently in service on the requested line(s) — service may have ended for the night.'
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// cta_bus_predictions

interface RawPrd {
  tmstmp: string;
  typ: string;
  stpnm: string;
  stpid: string;
  vid: string;
  rt: string;
  rtdir: string;
  des: string;
  prdtm: string;
  dly: boolean;
  prdctdn: string;
}

interface RawStop {
  stpid: string;
  stpnm: string;
  lat: number;
  lon: number;
}

/** Resolve a stop-name fragment on a route to up to 5 stops via getdirections + getstops. */
async function findStops(
  route: string,
  fragment: string,
  directionFilter: string | undefined,
  busKey: string,
): Promise<Array<RawStop & { direction: string }>> {
  const dirBody = await busApi('getdirections', { rt: route }, busKey);
  const dirErr = busErrorNote(dirBody);
  let dirs = toArray(dirBody.directions as Array<{ dir: string }> | { dir: string }).map((d) => d.dir);
  if (dirs.length === 0) {
    throw new Error(`CTA Bus Tracker: no directions found for route "${route}"${dirErr ? ` — ${dirErr}` : ''}. Check the route number (e.g. "22", "66").`);
  }
  if (directionFilter) {
    const df = directionFilter.trim().toLowerCase();
    const narrowed = dirs.filter((d) => d.toLowerCase().startsWith(df) || df.startsWith(d.toLowerCase().replace(/bound$/, '')));
    if (narrowed.length > 0) dirs = narrowed;
  }

  const allStops: Array<RawStop & { direction: string; norm: string }> = [];
  for (const dir of dirs) {
    const stopsBody = await busApi('getstops', { rt: route, dir }, busKey);
    for (const s of toArray(stopsBody.stops as RawStop[] | RawStop)) {
      allStops.push({ ...s, direction: dir, norm: normName(s.stpnm) });
    }
  }

  // Token match: "clark & madison" → [clark, madison]; a stop must contain every
  // token (order-independent, so "madison & clark" works too). If nothing contains
  // all tokens (e.g. the bus runs on Dearborn northbound, so there is no
  // "Clark & Madison"), fall back to the single token with the fewest — most
  // specific — matches ("madison" → "Dearborn & Madison").
  const tokens = fragment
    .toLowerCase()
    .split(/\s*(?:&|\/|,|\band\b)\s*/)
    .map(normName)
    .filter(Boolean);
  const q = normName(fragment);
  let matches: Array<RawStop & { direction: string; norm: string }> =
    tokens.length > 0
      ? allStops.filter((s) => tokens.every((t) => s.norm.includes(t)))
      : allStops.filter((s) => s.norm.includes(q));
  if (matches.length === 0 && tokens.length > 1) {
    let best: typeof matches = [];
    for (const t of tokens) {
      const hits = allStops.filter((s) => s.norm.includes(t));
      if (hits.length > 0 && (best.length === 0 || hits.length < best.length)) best = hits;
    }
    matches = best;
  }
  if (matches.length === 0) {
    throw new Error(
      `CTA Bus Tracker: no stop on route ${route}${directionFilter ? ` (${dirs.join('/')})` : ''} matched "${fragment}". Try a street or intersection fragment like "madison" or "clark & addison", or pass the stop_id from the bus-stop sign.`,
    );
  }
  return matches.slice(0, 5);
}

async function busPredictions(args: Record<string, unknown>, busKey: string) {
  const route = args.route ? String(args.route).trim() : undefined;
  const max = clampNum(args.max, 10, 1, 20);
  let stopIds = args.stop_id ? String(args.stop_id).trim() : '';
  let matchedStops: Array<RawStop & { direction: string }> | undefined;

  if (!stopIds) {
    const fragment = args.find_stop ? String(args.find_stop).trim() : '';
    if (!fragment) {
      throw new Error(
        'cta_bus_predictions requires stop_id (the number on the CTA bus-stop sign, e.g. "1926"), or route + find_stop to look a stop up by name, e.g. { route: "22", find_stop: "clark & madison" }.',
      );
    }
    if (!route) {
      throw new Error('cta_bus_predictions: find_stop requires a route, e.g. { route: "22", find_stop: "madison" }.');
    }
    matchedStops = await findStops(route, fragment, args.direction ? String(args.direction) : undefined, busKey);
    stopIds = matchedStops.map((s) => s.stpid).join(',');
  }

  const params: Record<string, string> = { stpid: stopIds, top: String(max) };
  if (route) params.rt = route;
  const body = await busApi('getpredictions', params, busKey);
  const note = busErrorNote(body);

  const predictions = toArray(body.prd as RawPrd[] | RawPrd).map((p) => ({
    route: p.rt,
    direction: p.rtdir,
    destination: p.des,
    stop: p.stpnm,
    stop_id: p.stpid,
    type: p.typ === 'D' ? 'departure' : 'arrival',
    predicted_time: p.prdtm, // "yyyyMMdd HH:mm" Chicago local
    minutes: p.prdctdn === 'DUE' ? 0 : p.prdctdn === 'DLY' ? null : Number(p.prdctdn),
    due: p.prdctdn === 'DUE',
    delayed: p.dly === true || p.prdctdn === 'DLY',
    vehicle_id: p.vid,
  }));

  return {
    stop_ids: stopIds,
    matched_stops: matchedStops?.map((s) => ({
      stop_id: s.stpid,
      name: s.stpnm,
      direction: s.direction,
      latitude: s.lat,
      longitude: s.lon,
    })),
    count: predictions.length,
    note:
      predictions.length === 0
        ? `No predictions right now${note ? ` — ${note}` : ''}. Stop ids are the 4-5 digit numbers on CTA bus-stop signs.`
        : note,
    predictions,
  };
}

// ---------------------------------------------------------------------------
// cta_bus_positions

interface RawVehicle {
  vid: string;
  tmstmp: string;
  lat: string;
  lon: string;
  hdg: string;
  rt: string;
  des: string;
  pdist: number;
  dly: boolean;
}

async function busPositions(args: Record<string, unknown>, busKey: string) {
  const route = String(args.route ?? '').trim();
  if (!route) throw new Error('cta_bus_positions requires a route, e.g. { route: "22" }.');
  const body = await busApi('getvehicles', { rt: route }, busKey);
  const note = busErrorNote(body);

  const vehicles = toArray(body.vehicle as RawVehicle[] | RawVehicle).map((v) => ({
    vehicle_id: v.vid,
    route: v.rt,
    destination: v.des,
    latitude: Number(v.lat),
    longitude: Number(v.lon),
    heading_degrees: Number(v.hdg),
    pattern_distance_feet: v.pdist,
    delayed: v.dly === true,
    updated_at: v.tmstmp, // "yyyyMMdd HH:mm" Chicago local
  }));

  return {
    route,
    count: vehicles.length,
    note:
      vehicles.length === 0
        ? `No buses currently tracked on route ${route}${note ? ` — ${note}` : ''}.`
        : note,
    vehicles,
  };
}

// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { trainKey, busKey } = splitKeys(args);
  switch (name) {
    case 'cta_train_arrivals':
      return trainArrivals(args, trainKey);
    case 'cta_train_positions':
      return trainPositions(args, trainKey);
    case 'cta_bus_predictions':
      return busPredictions(args, busKey);
    case 'cta_bus_positions':
      return busPositions(args, busKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
