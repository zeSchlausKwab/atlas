import { expect, test } from "bun:test";
import { adminAccess } from "../apps/server/admin-access";
const url = "http://192.168.0.179:3100";
const request = (origin?: string, host = url) =>
  new Request(host + "/admin/preparations", {
    headers: origin ? { Origin: origin } : {},
  });
test("LAN console requires both configured origin and actual peer subnet", () => {
  const access = adminAccess(url, "192.168.0.0/24");
  expect(adminAccess()(request(), "192.168.0.10")).toBe(false);
  expect(access(request(), "192.168.0.10")).toBe(true);
  expect(access(request(url), "::ffff:192.168.0.10")).toBe(true);
  expect(access(request(), "192.168.1.10")).toBe(false);
  expect(access(request(), "203.0.113.5")).toBe(false);
  expect(access(request(), undefined)).toBe(false);
  expect(
    access(request(undefined, "http://attacker.example:3100"), "192.168.0.10"),
  ).toBe(false);
  expect(
    access(request(undefined, "http://192.168.0.179:3101"), "192.168.0.10"),
  ).toBe(false);
  expect(access(request("http://attacker.example"), "192.168.0.10")).toBe(
    false,
  );
  expect(
    access(
      new Request(url + "/admin/operations", {
        headers: { "X-Forwarded-For": "192.168.0.10" },
      }),
      "203.0.113.5",
    ),
  ).toBe(false);
});
test("local console remains usable and invalid trust configuration fails closed", () => {
  const access = adminAccess();
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    expect(access(request(undefined, "http://localhost:3100"), peer)).toBe(
      true,
    );
  expect(
    access(request(undefined, "http://attacker.example"), "127.0.0.1"),
  ).toBe(false);
  for (const [origins, subnets] of [
    [url, ""],
    ["", "192.168.0.0/24"],
    [url + "/path", "192.168.0.0/24"],
    [url, "0.0.0.0/0"],
    [url, "192.168.0.0/33"],
  ])
    expect(() => adminAccess(origins, subnets)).toThrow();
});

import { Preparations } from "../apps/server/preparations";
import { hostPolicy } from "../apps/server/policy";
import { OperationHost } from "../packages/operations/src/host";
import { pluginFixture } from "./helpers/plugin-fixture";
import { mkdtemp, rm } from "node:fs/promises";
test("real host console handlers load over configured LAN, retain JSON origin checks", async () => {
  const fixture = await pluginFixture(),
    directory = await mkdtemp("/tmp/atlas-admin-lan-");
  const access = adminAccess(url, "192.168.0.0/24");
  const manager = await Preparations.open(
    directory,
    directory + "/source.atlas",
    fixture.reader.index.manifest,
    access,
  );
  try {
    const response = await manager.handle(request(), "192.168.0.10");
    expect(response.status).toBe(200);
    expect((await response.json()).source.snapshot).toBe(
      fixture.reader.index.manifest.snapshot,
    );
    const policy = await hostPolicy(
      new OperationHost(fixture.engine),
      directory + "/policy.json",
      () => {},
      access,
    );
    expect(
      (await policy(new Request(url + "/admin/operations"), "192.168.0.10"))
        .status,
    ).toBe(200);
    const body = JSON.stringify({
      id: fixture.ref.id,
      implementation: fixture.ref.implementation,
      enabled: false,
    });
    for (const origin of [undefined, "http://evil.example", url]) {
      const response = await policy(
        new Request(url + "/admin/operations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body,
        }),
        "192.168.0.10",
      );
      expect(response.status).toBe(origin === url ? 200 : 403);
    }
  } finally {
    await manager.close();
    fixture.engine.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
