interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
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
  if (!res.ok) throw new Error(`CTA Train Tracker: HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(`CTA Bus Tracker: HTTP ${res.status}`);
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
