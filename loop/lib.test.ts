import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batonArchivePath,
  iterationCounterPath,
  lastTickPath,
  nextDueEpoch,
  parseLoopEnv,
  parseSchedule,
  staleArchives,
} from "./lib.ts";

test("a cron expression answers its next fire in local time", () => {
  const schedule = parseSchedule("0 8 * * 1");
  assert.ok(schedule);
  const wednesday = new Date(2026, 8, 2, 10, 0, 0).getTime() / 1000;
  assert.equal(
    schedule.nextAfter(wednesday),
    new Date(2026, 8, 7, 8, 0, 0).getTime() / 1000,
  );
  // Strictly after: standing on a fire moves to the following one.
  assert.equal(
    schedule.nextAfter(new Date(2026, 8, 7, 8, 0, 0).getTime() / 1000),
    new Date(2026, 8, 14, 8, 0, 0).getTime() / 1000,
  );
});

test("cron fields take steps, lists and ranges", () => {
  const schedule = parseSchedule("*/15 9-17 * * 1,5");
  assert.ok(schedule);
  const friday = new Date(2026, 8, 4, 9, 5, 0).getTime() / 1000;
  assert.equal(
    schedule.nextAfter(friday),
    new Date(2026, 8, 4, 9, 15, 0).getTime() / 1000,
  );
  // Friday 17:45 is the last window of the day; the next is Monday 09:00.
  assert.equal(
    schedule.nextAfter(new Date(2026, 8, 4, 17, 45, 0).getTime() / 1000),
    new Date(2026, 8, 7, 9, 0, 0).getTime() / 1000,
  );
});

test("a malformed cron expression is rejected", () => {
  assert.equal(parseSchedule("0 8 * *"), undefined);
  assert.equal(parseSchedule("0 99 * * *"), undefined);
  assert.equal(parseSchedule("every monday"), undefined);
});

test("no stamp reads as due now, a stamp as last tick plus cadence", () => {
  assert.equal(nextDueEpoch(null, 60), null);
  assert.equal(nextDueEpoch(1000, 60), 1060);
  const schedule = parseSchedule("0 8 * * 1");
  assert.ok(schedule);
  const stamp = new Date(2026, 8, 2, 10, 0, 0).getTime() / 1000;
  assert.equal(
    nextDueEpoch(stamp, 0, schedule),
    new Date(2026, 8, 7, 8, 0, 0).getTime() / 1000,
  );
});

test("the spawn env becomes the loop config", () => {
  const config = parseLoopEnv({
    CODASS_LOOP: "daily",
    LOOP_SKILL: "loop-daily",
    LOOP_CADENCE: "1800",
    HANDOFF_PATH: "/c/loops/daily/handoff.md",
    HANDOFF_AT: "90000",
    MAX_ITERS: "6",
  });
  assert.deepEqual(
    { ...config, schedule: undefined },
    {
      name: "daily",
      skill: "loop-daily",
      batonPath: "/c/loops/daily/handoff.md",
      handoffAt: 90000,
      maxIters: 6,
      cadenceSeconds: 1800,
      schedule: undefined,
    },
  );
});

test("the thresholds fall back to codass's defaults", () => {
  const config = parseLoopEnv({
    CODASS_LOOP: "daily",
    LOOP_SKILL: "loop-daily",
    LOOP_CADENCE: "60",
    HANDOFF_PATH: "/c/loops/daily/handoff.md",
  });
  assert.equal(config?.handoffAt, 120000);
  assert.equal(config?.maxIters, 10);
});

test("without the loop env there is no loop", () => {
  assert.equal(parseLoopEnv({}), undefined);
  assert.equal(parseLoopEnv({ CODASS_LOOP: "daily" }), undefined);
  assert.equal(
    parseLoopEnv({ CODASS_LOOP: "daily", LOOP_SKILL: "x" }),
    undefined,
  );
  for (const cadence of ["soon", "30m", "0", "-60", "1.5"]) {
    assert.equal(
      parseLoopEnv({
        CODASS_LOOP: "daily",
        LOOP_SKILL: "x",
        HANDOFF_PATH: "/c/loops/daily/handoff.md",
        LOOP_CADENCE: cadence,
      }),
      undefined,
    );
  }
});

test("the state files sit beside the baton codass named", () => {
  assert.equal(
    lastTickPath("/c/loops/daily/handoff.md"),
    "/c/loops/daily/.last-tick",
  );
  assert.equal(
    iterationCounterPath("/c/loops/daily/handoff.md", "abc"),
    "/c/loops/daily/.iter-abc",
  );
  assert.equal(
    iterationCounterPath("/c/loops/daily/handoff.md", ""),
    "/c/loops/daily/.iter-unknown",
  );
});

/** Run `body` as if the machine sat in a zone that observes European DST. */
function inParis(body: () => void): void {
  const tz = process.env.TZ;
  process.env.TZ = "Europe/Paris";
  try {
    body();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}

test("a cron slot skipped by spring forward fires just after the gap", () => {
  inParis(() => {
    const schedule = parseSchedule("30 2 * * *");
    assert.ok(schedule);
    // 2026-03-29, Paris: 02:00 CET becomes 03:00 CEST, so 02:30 never happens.
    const before = Date.UTC(2026, 2, 29, 0, 0) / 1000;
    assert.equal(
      schedule.nextAfter(before),
      Date.UTC(2026, 2, 29, 1, 30) / 1000,
    );
  });
});

test("a cron slot repeated by fall back fires once, at its first occurrence", () => {
  inParis(() => {
    const schedule = parseSchedule("30 2 * * *");
    assert.ok(schedule);
    // 2026-10-25, Paris: 03:00 CEST becomes 02:00 CET, so 02:30 happens twice.
    const first = Date.UTC(2026, 9, 25, 0, 30) / 1000;
    assert.equal(
      schedule.nextAfter(Date.UTC(2026, 9, 24, 23, 0) / 1000),
      first,
    );
    assert.equal(schedule.nextAfter(first), Date.UTC(2026, 9, 26, 1, 30) / 1000);
  });
});

test("a consumed baton is archived under a timestamped name", () => {
  assert.equal(
    batonArchivePath(
      "/c/loops/daily/handoff.md",
      new Date(Date.UTC(2026, 8, 6, 14, 3, 9, 42)),
    ),
    "/c/loops/daily/handoff-20260906T140309_042000Z.md",
  );
});

test("only the archives past the keep window are stale", () => {
  const names = [
    "handoff.md",
    ".last-tick",
    "handoff-3.md",
    "handoff-1.md",
    "handoff-2.md",
  ];
  assert.deepEqual(staleArchives(names, 2), ["handoff-1.md"]);
  assert.deepEqual(staleArchives(names, 5), []);
});
