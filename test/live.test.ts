import { expect, test } from "bun:test";
import worker from "../src/index";

// Live tests hit the real y.qq.com / c.y.qq.com endpoints.
// Run with: bun test test/live.test.ts

const LINUX_DEB =
  "ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb";

async function call(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://api.example.com${path}`), {} as never, {
    waitUntil() {},
  });
}

test(
  "live: resolves and verifies the Linux deb sign",
  async () => {
    const res = await call(`/api/sign?file=${LINUX_DEB}&refresh=1&verify=1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file).toBe(LINUX_DEB);
    expect(body.sign).toMatch(/^1-[0-9a-f]{64}-[0-9a-f]{8}$/);
    expect(body.sign).toBe(
      "1-d1ca4d5c5a8369b26af88e881ba3ac544066a899dcaea29778b35c9f648e6fee-68cb7c1c",
    );
    expect(body.verification.status).toBe(302);
    expect(body.verification.location).toContain("dldir.y.qq.com");
  },
  30_000,
);

test(
  "live: follows the signed URL to the CDN",
  async () => {
    const res = await call(`/api/url?file=${LINUX_DEB}&follow=1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.httpStatus).toBe(302);
    expect(body.finalUrl).toStartWith("https://dldir.y.qq.com/");
    expect(body.finalUrl).toContain("qqmusic_1.1.8_amd64.deb");
  },
  30_000,
);
