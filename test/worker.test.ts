import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import worker from "../src/index";

const FIXTURE = await Bun.file(join(import.meta.dir, "fixtures", "download.js")).text();

const LINUX_DEB =
  "ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb";
const LINUX_APPIMAGE =
  "ecosfile_plink/music_clntupate/linux/other/qqmusic-1.1.8.AppImage";
const LINUX_DEB_SIGN =
  "1-d1ca4d5c5a8369b26af88e881ba3ac544066a899dcaea29778b35c9f648e6fee-68cb7c1c";
const LINUX_APPIMAGE_SIGN =
  "1-845b70c2cc9293f3393a2ce533d708f75362c0c7f412dcc1b1a3f42b8cf0bb34-68cb7c17";
const REDIRECT_TARGET =
  "https://dldir.y.qq.com/ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb?sign=1792563143-wCuRwje809O5IFMI-0-fc8fa0dbc2d10065f380a3a01cdad132";

const realFetch = globalThis.fetch;
let upstreamMode: "ok" | "fail" | "redirect" = "ok";
let upstreamCalls = 0;
let redirectCalls = 0;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    if (url.startsWith("https://y.qq.com/download/download.js")) {
      upstreamCalls += 1;
      if (upstreamMode === "fail") throw new Error("simulated upstream outage");
      return new Response(FIXTURE, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    if (url.startsWith("https://c.y.qq.com/cgi-bin/file_redirect.fcg")) {
      redirectCalls += 1;
      if (upstreamMode === "fail") throw new Error("simulated redirect outage");
      return new Response(null, { status: 302, headers: { location: REDIRECT_TARGET } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

beforeEach(() => {
  upstreamCalls = 0;
  redirectCalls = 0;
  upstreamMode = "ok";
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://api.example.com${path}`, init), {} as never, {
    waitUntil() {},
  });
}

async function callJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any; res: Response }> {
  const res = await call(path, init);
  return { status: res.status, body: await res.json(), res };
}

describe("routing", () => {
  test("GET / describes the API", async () => {
    const { status, body } = await callJson("/");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.endpoints["GET /api/sign?file=<path|url>&verify=1"]).toBeTruthy();
  });

  test("GET /health does not touch the upstream", async () => {
    const { status, body } = await callJson("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(upstreamCalls).toBe(0);
  });

  test("unknown route -> 404 route_not_found", async () => {
    const { status, body } = await callJson("/nope");
    expect(status).toBe(404);
    expect(body.error.code).toBe("route_not_found");
  });

  test("POST -> 405", async () => {
    const { status, body } = await callJson("/api/sign?file=x", { method: "POST" });
    expect(status).toBe(405);
    expect(body.error.code).toBe("method_not_allowed");
  });

  test("HEAD returns no body", async () => {
    const res = await call(`/api/sign?file=${LINUX_DEB}&refresh=1`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("CORS headers are set", async () => {
    const res = await call("/health");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS preflight -> 204", async () => {
    const res = await call("/api/sign", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

describe("catalog", () => {
  test("GET /api/downloads returns every platform with links", async () => {
    const { status, body } = await callJson("/api/downloads?refresh=1");
    expect(status).toBe(200);
    expect(body.count).toBe(18);
    const linux = body.items.find((item: any) => item.platform === "Linux");
    expect(linux.version).toBe("1.1.8");
    expect(linux.releaseDate).toBe("2025-09-18");
    expect(linux.links).toHaveLength(2);
    expect(linux.links[0].sign).toBe(LINUX_DEB_SIGN);
  });

  test("parses JSONP and keeps direct (unsigned) links", async () => {
    const { body } = await callJson("/api/downloads");
    const iphone = body.items.find((item: any) => item.platform === "iPhone");
    expect(iphone.links[0].kind).toBe("direct");
    expect(iphone.links[0].sign).toBeNull();
  });
});

describe("sign lookup", () => {
  test("exact file path", async () => {
    const { status, body, res } = await callJson(`/api/sign?file=${LINUX_DEB}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sign).toBe(LINUX_DEB_SIGN);
    expect(body.bid).toBe("dldir");
    expect(body.platform).toBe("Linux");
    expect(body.version).toBe("1.1.8");
    expect(body.signIssuedAt).toBe("2025-09-18T03:27:24.000Z");
    expect(body.url).toContain(`file=ecosfile_plink%2Fmusic_clntupate%2Flinux%2Fother%2Fqqmusic_1.1.8_amd64.deb`);
    expect(body.url).toContain(`sign=${LINUX_DEB_SIGN}`);
    expect(["hit", "miss"]).toContain(res.headers.get("x-catalog-cache"));
  });

  test("path suffix, encoded path and bare file name all match", async () => {
    for (const query of [
      "linux/other/qqmusic-1.1.8.AppImage",
      encodeURIComponent(LINUX_APPIMAGE),
      "qqmusic-1.1.8.AppImage",
      LINUX_APPIMAGE.toUpperCase(),
    ]) {
      const { status, body } = await callJson(`/api/sign?file=${query}`);
      expect(status).toBe(200);
      expect(body.sign).toBe(LINUX_APPIMAGE_SIGN);
    }
  });

  test("full URL parameter", async () => {
    const target = `https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=${encodeURIComponent(
      LINUX_DEB,
    )}`;
    const { status, body } = await callJson(`/api/sign?url=${encodeURIComponent(target)}`);
    expect(status).toBe(200);
    expect(body.sign).toBe(LINUX_DEB_SIGN);
  });

  test("full signed URL is answered without any upstream request", async () => {
    upstreamMode = "fail";
    const target = `https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=${encodeURIComponent(
      LINUX_DEB,
    )}&sign=${LINUX_DEB_SIGN}`;
    const { status, body } = await callJson(`/api/url?url=${encodeURIComponent(target)}`);
    expect(status).toBe(200);
    expect(body.sign).toBe(LINUX_DEB_SIGN);
    expect(body.source).toBe("input");
    expect(upstreamCalls).toBe(0);
  });

  test("unknown file -> 404 with the known file list", async () => {
    const { status, body } = await callJson("/api/sign?file=linux/other/does-not-exist.deb");
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.error.details.knownFiles).toContain(LINUX_DEB);
  });

  test("missing file -> 400", async () => {
    const { status, body } = await callJson("/api/sign");
    expect(status).toBe(400);
    expect(body.error.code).toBe("missing_file");
  });

  test("format=text returns only the sign", async () => {
    const res = await call(`/api/sign?file=${LINUX_DEB}&format=text`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(LINUX_DEB_SIGN);
  });

  test("verify=1 HEAD-checks the sign upstream", async () => {
    const { status, body } = await callJson(`/api/sign?file=${LINUX_DEB}&verify=1`);
    expect(status).toBe(200);
    expect(redirectCalls).toBe(1);
    expect(body.verification.ok).toBe(true);
    expect(body.verification.status).toBe(302);
    expect(body.verification.location).toBe(REDIRECT_TARGET);
  });
});

describe("url endpoint", () => {
  test("returns the signed file_redirect URL", async () => {
    const { status, body } = await callJson(`/api/url?file=${LINUX_DEB}`);
    expect(status).toBe(200);
    expect(body.url).toStartWith("https://c.y.qq.com/cgi-bin/file_redirect.fcg?");
    expect(body.finalUrl).toBeUndefined();
    expect(redirectCalls).toBe(0);
  });

  test("follow=1 resolves the final CDN URL", async () => {
    const { status, body } = await callJson(`/api/url?file=${LINUX_DEB}&follow=1`);
    expect(status).toBe(200);
    expect(body.httpStatus).toBe(302);
    expect(body.finalUrl).toBe(REDIRECT_TARGET);
  });

  test("failed redirect -> 502 redirect_failed", async () => {
    const { status, body } = await callJson(`/api/url?file=${LINUX_DEB}&follow=1&refresh=1`);
    expect(status).toBe(200);
    upstreamMode = "fail";
    const failed = await callJson(`/api/url?file=${LINUX_DEB}&follow=1`);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("redirect_failed");
    expect(body.ok).toBe(true);
  });
});

describe("caching", () => {
  test("second request is served from the in-memory cache", async () => {
    await callJson(`/api/sign?file=${LINUX_DEB}&refresh=1`);
    expect(upstreamCalls).toBe(1);
    await callJson(`/api/sign?file=${LINUX_DEB}`);
    expect(upstreamCalls).toBe(1);
  });

  test("stale catalog survives an upstream outage", async () => {
    await callJson(`/api/sign?file=${LINUX_DEB}&refresh=1`);
    upstreamMode = "fail";
    const { status, body, res } = await callJson(`/api/sign?file=${LINUX_DEB}&refresh=1`);
    expect(status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.sign).toBe(LINUX_DEB_SIGN);
    expect(res.headers.get("x-catalog-cache")).toBe("stale");
  });
});

describe("mirror-style prefix (Gentoo ebuild)", () => {
  const official =
    "https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=" +
    encodeURIComponent(LINUX_DEB);

  test("302s to the official URL with a current sign appended", async () => {
    const res = await call(`/${official}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=${encodeURIComponent(LINUX_DEB)}&sign=${LINUX_DEB_SIGN}`,
    );
    expect(res.headers.get("x-qqmusic-sign-source")).toBe("y.qq.com/download/download.js");
  });

  test("accepts a single slash after the scheme", async () => {
    const res = await call(`/${official.replace("https://", "https:/")}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`sign=${LINUX_DEB_SIGN}`);
  });

  test("rejects a non-official host", async () => {
    const res = await call("/https://example.com/cgi-bin/file_redirect.fcg?file=x");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unsupported_url");
  });

  test("unknown official file -> 404", async () => {
    const res = await call(
      "/https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=ecosfile_plink%2Fnope.deb",
    );
    expect(res.status).toBe(404);
  });
});
