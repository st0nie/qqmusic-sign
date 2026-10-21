/**
 * QQ Music download-link sign API (Cloudflare Worker).
 *
 * The `sign` parameter of
 *   https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=…&sign=…
 * is issued by QQ Music's backend (HMAC-like, bound to the exact file path).
 * It cannot be derived locally, so this worker scrapes the signed URLs that
 * the official page publishes in https://y.qq.com/download/download.js and
 * exposes them as JSON endpoints. The catalog is cached in memory, in the
 * Workers Cache API and (via `cf.cacheTtl`) at the Cloudflare edge.
 */

const UPSTREAM_URL = "https://y.qq.com/download/download.js";
const SOURCE = "y.qq.com/download/download.js";
const CACHE_KEY = "https://qqmusic-sign.cache.internal/catalog-v1";
const FRESH_MS = 30 * 60 * 1000; // serve cached catalog for 30 minutes
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // fall back to stale cache for a week
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ types */

interface Env {
  [key: string]: never;
}

interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

/** RequestInit plus Cloudflare's `cf` extension (ignored by non-Workers runtimes). */
interface WorkerFetchInit extends RequestInit {
  cf?: { cacheTtl?: number; cacheEverything?: boolean };
}

interface Link {
  kind: "signed" | "direct";
  url: string;
  bid: string | null;
  file: string | null;
  sign: string | null;
  signVersion: number | null;
  signIssuedAt: number | null;
  signIssuedAtISO: string | null;
}

interface Item {
  id: number | null;
  platform: string;
  version: string;
  versionLabel: string;
  releaseDate: string | null;
  releaseNotes: string | null;
  icon: string | null;
  links: Link[];
}

/** Shape of one row in the upstream JSONP payload (only the fields we read). */
interface RawRow {
  ID?: unknown;
  Ftitle?: unknown;
  Fversion?: unknown;
  Fdesc?: unknown;
  Fpic?: unknown;
  Flink1?: unknown;
  Flink2?: unknown;
}

interface Catalog {
  fetchedAt: number;
  upstream: string;
  items: Item[];
}

interface CacheMeta {
  cached: boolean;
  stale: boolean;
}

interface Hit {
  item: Item;
  link: Link & { file: string; sign: string };
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------ upstream catalog */

let memo: Catalog | null = null;

async function loadCatalog(
  refresh: boolean,
  ctx: ExecutionContextLike,
): Promise<{ catalog: Catalog } & CacheMeta> {
  const now = Date.now();

  if (!refresh && memo && now - memo.fetchedAt < FRESH_MS) {
    return { catalog: memo, cached: true, stale: false };
  }

  const cached = await cacheGet();
  if (!refresh && cached && now - cached.fetchedAt < FRESH_MS) {
    memo = cached;
    return { catalog: cached, cached: true, stale: false };
  }

  try {
    const catalog = await fetchCatalog();
    memo = catalog;
    storeCache(catalog, ctx);
    return { catalog, cached: false, stale: false };
  } catch (error) {
    const fallback = memo ?? cached;
    if (fallback && now - fallback.fetchedAt < STALE_MAX_MS) {
      return { catalog: fallback, cached: true, stale: true };
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "upstream_unavailable",
      `Failed to fetch ${UPSTREAM_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchCatalog(): Promise<Catalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    const init: WorkerFetchInit = {
      headers: {
        accept: "*/*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        referer: "https://y.qq.com/download/index.html",
        "user-agent": USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 60, cacheEverything: true },
    };
    response = await fetch(UPSTREAM_URL, init);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ApiError(502, "upstream_http_error", `Upstream responded with HTTP ${response.status}.`);
  }

  const text = await response.text();
  const items = parseCatalog(text);
  if (items.length === 0) {
    throw new ApiError(502, "upstream_parse_error", "Upstream response contained no signed download links.");
  }

  return { fetchedAt: Date.now(), upstream: UPSTREAM_URL, items };
}

function parseCatalog(text: string): Item[] {
  let doc: unknown;
  try {
    const start = text.indexOf("(");
    const end = text.lastIndexOf(")");
    const json = start >= 0 && end > start ? text.slice(start + 1, end) : text;
    doc = JSON.parse(json);
  } catch {
    throw new ApiError(502, "upstream_parse_error", "Upstream response is not valid JSONP/JSON.");
  }

  const rows = (doc as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];

  const items: Item[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as RawRow;
    const links = [parseLink(record.Flink1), parseLink(record.Flink2)].filter(
      (link): link is Link => link !== null,
    );
    if (links.length === 0) continue;

    const versionLabel = asString(record.Fversion) ?? "";
    items.push({
      id: typeof record.ID === "number" ? record.ID : null,
      platform: asString(record.Ftitle) ?? "Unknown",
      version: versionLabel.replace(/^最新版\s*[:：]\s*/, ""),
      versionLabel,
      releaseDate: parseReleaseDate(asString(record.Fdesc)),
      releaseNotes: asString(record.Fdesc),
      icon: asString(record.Fpic) || null,
      links,
    });
  }
  return items;
}

function parseLink(raw: unknown): Link | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const file = parsed.searchParams.get("file");
  const sign = parsed.searchParams.get("sign");
  if (!file || !sign) {
    // Direct download (iTunes, dldir.y.qq.com, …): keep it, but it has no sign.
    return {
      kind: "direct",
      url: value,
      bid: null,
      file: null,
      sign: null,
      signVersion: null,
      signIssuedAt: null,
      signIssuedAtISO: null,
    };
  }

  const meta = describeSign(sign);
  return {
    kind: "signed",
    url: value,
    bid: parsed.searchParams.get("bid") || "dldir",
    file,
    sign,
    signVersion: meta.version,
    signIssuedAt: meta.issuedAt,
    signIssuedAtISO: meta.issuedAtISO,
  };
}

interface SignMeta {
  version: number | null;
  issuedAt: number | null;
  issuedAtISO: string | null;
}

function describeSign(sign: string): SignMeta {
  const match = /^(\d+)-([0-9a-fA-F]{64})-([0-9a-fA-F]{1,16})$/.exec(sign.trim());
  if (!match) return { version: null, issuedAt: null, issuedAtISO: null };

  const issuedAt = Number.parseInt(match[3], 16);
  // The trailing 32-bit value is the Unix time (seconds) the sign was issued.
  const valid = Number.isFinite(issuedAt) && issuedAt > 0 && issuedAt < 4_102_444_800;
  return {
    version: Number(match[1]),
    issuedAt: valid ? issuedAt : null,
    issuedAtISO: valid ? new Date(issuedAt * 1000).toISOString() : null,
  };
}

function parseReleaseDate(description: string | null): string | null {
  if (!description) return null;
  const match = /发布时间\s*[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(description);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------ cache tier */

async function cacheGet(): Promise<Catalog | null> {
  try {
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return null;
    const response = await cache.match(CACHE_KEY);
    if (!response) return null;
    const payload = (await response.json()) as Catalog;
    if (!payload || !Array.isArray(payload.items) || typeof payload.fetchedAt !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

function storeCache(catalog: Catalog, ctx: ExecutionContextLike): void {
  const task = (async () => {
    try {
      const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
      if (!cache) return;
      await cache.put(
        CACHE_KEY,
        new Response(JSON.stringify(catalog), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "max-age=86400",
          },
        }),
      );
    } catch {
      // Cache API is best-effort (e.g. unavailable under `bun test`).
    }
  })();
  ctx.waitUntil?.(task);
}

/* ------------------------------------------------------------- matching */

function normalizeFile(input: string): string {
  let value = input.trim();
  if (value.startsWith("//")) value = `https:${value}`;
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).searchParams.get("file") ?? value;
    } catch {
      // Keep the raw value; it is probably a plain path.
    }
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not percent-encoded.
  }
  return value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
}

function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function signedHits(items: Item[]): Hit[] {
  const hits: Hit[] = [];
  for (const item of items) {
    for (const link of item.links) {
      if (link.kind === "signed" && link.file && link.sign) {
        hits.push({ item, link: link as Hit["link"] });
      }
    }
  }
  return hits;
}

function findHits(items: Item[], rawQuery: string): Hit[] {
  const query = normalizeFile(rawQuery);
  if (!query) return [];

  const lower = query.toLowerCase();
  const base = basename(query).toLowerCase();
  const all = signedHits(items);

  const strategies: Array<(hit: Hit) => boolean> = [
    (hit) => hit.link.file === query,
    (hit) => hit.link.file.toLowerCase() === lower,
    (hit) => hit.link.file.toLowerCase().endsWith(`/${lower}`),
    (hit) => basename(hit.link.file).toLowerCase() === base,
    (hit) => hit.link.file.toLowerCase().endsWith(lower),
  ];

  for (const strategy of strategies) {
    const found = all.filter(strategy);
    if (found.length > 0) return found;
  }
  return [];
}

/* -------------------------------------------------------------- handlers */

async function handle(request: Request, ctx: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  const proxied = extractPrefixedUrl(url);
  if (proxied) return redirectToSigned(proxied, url, ctx);

  if (path === "/") return json(indexPayload());
  if (path === "/health") return json({ ok: true, status: "ok", upstream: UPSTREAM_URL });

  if (path === "/api/downloads" || path === "/downloads") {
    const refresh = isTruthy(url.searchParams.get("refresh"));
    const { catalog, cached, stale } = await loadCatalog(refresh, ctx);
    return json(
      {
        ok: true,
        source: SOURCE,
        fetchedAt: new Date(catalog.fetchedAt).toISOString(),
        count: catalog.items.length,
        cached,
        stale,
        items: catalog.items.map(publicItem),
      },
      200,
      { "x-catalog-cache": cacheState(cached, stale) },
    );
  }

  if (path === "/api/sign" || path === "/sign") {
    return signResponse(url, ctx);
  }

  if (path === "/api/url" || path === "/url") {
    return urlResponse(url, ctx);
  }

  throw new ApiError(404, "route_not_found", `Unknown route: ${path}. See "/" for available endpoints.`);
}

async function signResponse(url: URL, ctx: ExecutionContextLike): Promise<Response> {
  const rawQuery = firstParam(url, ["file", "url", "q"]);
  if (!rawQuery) {
    throw new ApiError(400, "missing_file", 'Provide the file path as ?file=… (or a full signed URL as ?url=…).');
  }

  const body = await resolveLink(rawQuery, url, ctx);
  if (wantsText(url)) {
    return text(body.sign, { "x-catalog-cache": cacheState(body.cached, body.stale) });
  }
  return json(body, 200, { "x-catalog-cache": cacheState(body.cached, body.stale) });
}

async function urlResponse(url: URL, ctx: ExecutionContextLike): Promise<Response> {
  const rawQuery = firstParam(url, ["file", "url", "q"]);
  if (!rawQuery) {
    throw new ApiError(400, "missing_file", 'Provide the file path as ?file=… (or a full signed URL as ?url=…).');
  }

  const body = await resolveLink(rawQuery, url, ctx);
  const follow = isTruthy(url.searchParams.get("follow")) || isTruthy(url.searchParams.get("redirect"));
  if (follow) {
    const resolved = await followSignedUrl(body.url);
    body.finalUrl = resolved.finalUrl;
    body.httpStatus = resolved.status;
  }

  if (wantsText(url)) {
    return text(follow ? body.finalUrl ?? body.url : body.url, {
      "x-catalog-cache": cacheState(body.cached, body.stale),
    });
  }
  return json(body, 200, { "x-catalog-cache": cacheState(body.cached, body.stale) });
}

interface LinkResponse {
  ok: true;
  query: string;
  source: string;
  cached: boolean;
  stale: boolean;
  file: string;
  bid: string;
  sign: string;
  url: string;
  platform: string | null;
  version: string | null;
  versionLabel: string | null;
  releaseDate: string | null;
  signVersion: number | null;
  signIssuedAt: string | null;
  signIssuedAtUnix: number | null;
  verification?: { ok: boolean; status: number | null; location: string | null; error?: string };
  finalUrl?: string | null;
  httpStatus?: number;
}

async function resolveLink(rawQuery: string, url: URL, ctx: ExecutionContextLike): Promise<LinkResponse> {
  // Fast path: a full signed URL was supplied, no upstream request needed.
  const embedded = parseSignedInput(rawQuery);
  if (embedded) {
    return {
      ok: true,
      query: rawQuery,
      source: "input",
      cached: false,
      stale: false,
      file: embedded.file as string,
      bid: embedded.bid ?? "dldir",
      sign: embedded.sign as string,
      url: embedded.url,
      platform: null,
      version: null,
      versionLabel: null,
      releaseDate: null,
      signVersion: embedded.signVersion,
      signIssuedAt: embedded.signIssuedAtISO,
      signIssuedAtUnix: embedded.signIssuedAt,
    };
  }

  const refresh = isTruthy(url.searchParams.get("refresh"));
  const { catalog, cached, stale } = await loadCatalog(refresh, ctx);
  const hits = findHits(catalog.items, rawQuery);
  if (hits.length === 0) {
    throw new ApiError(
      404,
      "not_found",
      `No signed download link matches "${rawQuery}". Only files published on ${UPSTREAM_URL} have a sign.`,
      { file: normalizeFile(rawQuery), knownFiles: signedHits(catalog.items).map((hit) => hit.link.file) },
    );
  }
  if (hits.length > 1) {
    throw new ApiError(409, "ambiguous_match", `"${rawQuery}" matches ${hits.length} download links.`, {
      candidates: hits.map((hit) => ({
        file: hit.link.file,
        platform: hit.item.platform,
        version: hit.item.version,
      })),
    });
  }

  const hit = hits[0];
  const body: LinkResponse = {
    ok: true,
    query: rawQuery,
    source: SOURCE,
    cached,
    stale,
    file: hit.link.file,
    bid: hit.link.bid ?? "dldir",
    sign: hit.link.sign,
    url: hit.link.url,
    platform: hit.item.platform,
    version: hit.item.version,
    versionLabel: hit.item.versionLabel,
    releaseDate: hit.item.releaseDate,
    signVersion: hit.link.signVersion,
    signIssuedAt: hit.link.signIssuedAtISO,
    signIssuedAtUnix: hit.link.signIssuedAt,
  };

  if (isTruthy(url.searchParams.get("verify"))) {
    body.verification = await verifySignedUrl(body.url);
  }
  return body;
}

/**
 * Mirror-style prefix: the whole official URL is kept in the request path so
 * the download stays transparent to users.
 *   /https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=…
 * Cloudflare may collapse the `//` in the path, so `https:/…` is accepted too.
 */
function extractPrefixedUrl(url: URL): string | null {
  const match = /^\/(https?):\/{0,2}([^/].*)$/i.exec(url.pathname);
  if (!match) return null;
  return `${match[1].toLowerCase()}://${match[2]}${url.search}`;
}

async function redirectToSigned(
  rawTarget: string,
  url: URL,
  ctx: ExecutionContextLike,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new ApiError(400, "invalid_url", "The request path is not a valid absolute URL.");
  }
  if (target.hostname !== "c.y.qq.com" || target.pathname !== "/cgi-bin/file_redirect.fcg") {
    throw new ApiError(
      400,
      "unsupported_url",
      "Only https://c.y.qq.com/cgi-bin/file_redirect.fcg can be signed.",
    );
  }

  const file = target.searchParams.get("file");
  if (!file) throw new ApiError(400, "missing_file", "The official URL has no file parameter.");

  const refresh = isTruthy(url.searchParams.get("refresh"));
  const { catalog, cached, stale } = await loadCatalog(refresh, ctx);
  const hits = findHits(catalog.items, file);
  if (hits.length === 0) {
    throw new ApiError(404, "not_found", `No signed download link matches "${file}".`, {
      file: normalizeFile(file),
    });
  }
  if (hits.length > 1) {
    throw new ApiError(409, "ambiguous_match", `"${file}" matches ${hits.length} download links.`, {
      candidates: hits.map((hit) => ({ file: hit.link.file, platform: hit.item.platform })),
    });
  }

  return redirect(hits[0].link.url, {
    "x-catalog-cache": cacheState(cached, stale),
    "x-qqmusic-sign-source": SOURCE,
  });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "public, max-age=300",
      ...headers,
    },
  });
}

function parseSignedInput(raw: string): Link | null {  const value = raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim();
  if (!/^https?:\/\//i.test(value)) return null;
  const link = parseLink(value);
  return link && link.kind === "signed" ? link : null;
}

async function verifySignedUrl(signedUrl: string): Promise<{
  ok: boolean;
  status: number | null;
  location: string | null;
  error?: string;
}> {
  try {
    const response = await fetch(signedUrl, { method: "HEAD", redirect: "manual" });
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      location: response.headers.get("location"),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      location: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function followSignedUrl(signedUrl: string): Promise<{ finalUrl: string | null; status: number }> {
  let response: Response;
  try {
    response = await fetch(signedUrl, { method: "HEAD", redirect: "manual" });
  } catch (error) {
    throw new ApiError(
      502,
      "redirect_failed",
      `Could not reach the redirect endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new ApiError(
      502,
      "redirect_failed",
      `Signed URL did not redirect (HTTP ${response.status}); the sign may have expired.`,
      { status: response.status },
    );
  }
  return { finalUrl: location, status: response.status };
}

/* -------------------------------------------------------------- helpers */

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

function firstParam(url: URL, names: string[]): string {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function wantsText(url: URL): boolean {
  const format = (url.searchParams.get("format") ?? "").toLowerCase();
  return format === "text" || format === "plain" || isTruthy(url.searchParams.get("raw"));
}

function isTruthy(value: string | null): boolean {
  if (value === null) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cacheState(cached: boolean, stale: boolean): string {
  if (stale) return "stale";
  return cached ? "hit" : "miss";
}

function publicItem(item: Item) {
  return {
    id: item.id,
    platform: item.platform,
    version: item.version,
    versionLabel: item.versionLabel,
    releaseDate: item.releaseDate,
    releaseNotes: item.releaseNotes,
    icon: item.icon,
    links: item.links.map((link) => ({
      kind: link.kind,
      file: link.file,
      bid: link.bid,
      sign: link.sign,
      signIssuedAt: link.signIssuedAtISO,
      url: link.url,
    })),
  };
}

function indexPayload() {
  return {
    ok: true,
    service: "qqmusic-download-sign",
    description:
      "Looks up the official QQ Music download link signature (sign=1-<sha256>-<unix-time-hex>) from y.qq.com/download/download.js. Signs are issued server-side and bound to an exact file path, so they cannot be computed locally.",
    source: `https://${SOURCE}`,
    endpoints: {
      "GET /health": "liveness probe",
      "GET /api/downloads": "all platforms and every published download link (signed or direct)",
      "GET /api/sign?file=<path|url>&verify=1": "the sign for one file; verify=1 also HEAD-checks it upstream",
      "GET /api/url?file=<path|url>&follow=1": "the full signed file_redirect URL; follow=1 resolves the final CDN URL",
      "GET /<https://c.y.qq.com/cgi-bin/file_redirect.fcg?…>": "302 to the same official URL with a current sign appended; keeps the official URL visible (used by the Gentoo ebuild)",
    },
    notes: [
      "file accepts a full file_redirect URL, an absolute path, a path suffix or a bare file name.",
      "Add format=text (or raw=1) to /api/sign and /api/url to get a plain-text response.",
      "Add refresh=1 to bypass the 30 minute cache and re-read download.js.",
      "Catalog responses are cached for 30 minutes and served stale for up to 7 days if y.qq.com is unreachable.",
    ],
    example: {
      sign: "/api/sign?file=ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb",
      url: "/api/url?file=ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb&follow=1",
      list: "/api/downloads",
    },
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status >= 400 ? "no-store" : "public, max-age=300",
      ...headers,
    },
  });
}

function text(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...headers,
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    const payload: { code: string; message: string; details?: unknown } = {
      code: error.code,
      message: error.message,
    };
    if (error.details !== undefined) payload.details = error.details;
    return json({ ok: false, error: payload }, error.status);
  }
  return json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    500,
  );
}

async function handleWithCors(request: Request, ctx: ExecutionContextLike): Promise<Response> {
  let response: Response;
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "method_not_allowed", `Only GET, HEAD and OPTIONS are allowed (got ${request.method}).`);
    }
    response = await handle(request, ctx);
  } catch (error) {
    if (!(error instanceof ApiError)) console.error("unexpected error", error);
    response = errorResponse(error);
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  if (request.method === "HEAD") headers.delete("content-length");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}

export default {
  async fetch(request: Request, _env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    return handleWithCors(request, ctx ?? {});
  },
};
