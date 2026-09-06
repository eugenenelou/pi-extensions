import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_ENTRY_TYPE,
  AutoHandoff,
  parseAutoCommand,
  resolveThreshold,
  settingFromEntries,
} from "./auto.ts";

test("a threshold is a token count or a percentage of the model's window", () => {
  assert.equal(resolveThreshold(150000, 272000), 150000);
  assert.equal(resolveThreshold("150000", 272000), 150000);
  assert.equal(resolveThreshold("150k", 272000), 150000);
  assert.equal(resolveThreshold("1.5M", 272000), 1500000);
  assert.equal(resolveThreshold("75%", 200000), 150000);
  assert.equal(resolveThreshold("75%", 400000), 300000);
  assert.equal(resolveThreshold("soon", 272000), undefined);
  assert.equal(resolveThreshold(undefined, 272000), undefined);
});

test("auto off never fires, auto on fires only above the threshold", () => {
  const auto = new AutoHandoff({ enabled: false, at: "80%" });
  assert.equal(
    auto.shouldHandoff({ tokens: 260000, contextWindow: 272000 }),
    false,
  );
  auto.apply({ kind: "on" });
  assert.equal(
    auto.shouldHandoff({ tokens: 200000, contextWindow: 272000 }),
    false,
  );
  assert.equal(
    auto.shouldHandoff({ tokens: 220000, contextWindow: 272000 }),
    true,
  );
  // The window moved with the model: the same usage is now below the threshold.
  assert.equal(
    auto.shouldHandoff({ tokens: 220000, contextWindow: 1000000 }),
    false,
  );
  // Usage is unknown right after a compaction.
  assert.equal(
    auto.shouldHandoff({ tokens: null, contextWindow: 272000 }),
    false,
  );
  assert.equal(auto.shouldHandoff(undefined), false);
});

test("a config default fires without any conversation command", () => {
  const auto = new AutoHandoff({ enabled: true, at: 150000 });
  assert.equal(
    auto.shouldHandoff({ tokens: 149000, contextWindow: 272000 }),
    false,
  );
  assert.equal(
    auto.shouldHandoff({ tokens: 150000, contextWindow: 272000 }),
    true,
  );
});

test("an unusable threshold never fires", () => {
  const auto = new AutoHandoff({ enabled: true, at: "whenever" });
  assert.equal(
    auto.shouldHandoff({ tokens: 271000, contextWindow: 272000 }),
    false,
  );
});

test("`auto on|off|<value>` is told apart from a focus note", () => {
  assert.deepEqual(parseAutoCommand("auto on"), { kind: "on" });
  assert.deepEqual(parseAutoCommand("  auto   off "), { kind: "off" });
  assert.deepEqual(parseAutoCommand("auto 70%"), { kind: "at", at: "70%" });
  assert.deepEqual(parseAutoCommand("auto 150k"), { kind: "at", at: "150k" });
  assert.deepEqual(parseAutoCommand("auto"), { kind: "status" });
  assert.deepEqual(parseAutoCommand("auto nonsense"), {
    kind: "invalid",
    at: "nonsense",
  });
  assert.equal(parseAutoCommand("cover the migration"), undefined);
  assert.equal(parseAutoCommand("automatic tests are red"), undefined);
});

test("a value turns auto on at that threshold and is what gets persisted", () => {
  const auto = new AutoHandoff({ enabled: false, at: "80%" });
  assert.deepEqual(auto.apply({ kind: "at", at: "60%" }), {
    enabled: true,
    at: "60%",
  });
  assert.equal(
    auto.shouldHandoff({ tokens: 170000, contextWindow: 272000 }),
    true,
  );
  assert.deepEqual(auto.apply({ kind: "off" }), { enabled: false, at: "60%" });
  assert.equal(
    auto.shouldHandoff({ tokens: 271000, contextWindow: 272000 }),
    false,
  );
  // Back on keeps the conversation's own threshold, not the config default.
  assert.deepEqual(auto.apply({ kind: "on" }), { enabled: true, at: "60%" });
  assert.equal(auto.apply({ kind: "status" }), undefined);
});

test("a restored setting survives a resume and reaches the successor", () => {
  const auto = new AutoHandoff({ enabled: false, at: "80%" });
  auto.apply({ kind: "at", at: "50%" });
  const entries = [
    { type: "message" },
    { type: "custom", customType: "other", data: { enabled: true } },
    { type: "custom", customType: AUTO_ENTRY_TYPE, data: auto.setting() },
  ];
  assert.deepEqual(settingFromEntries(entries), { enabled: true, at: "50%" });

  const resumed = new AutoHandoff({ enabled: false, at: "80%" });
  resumed.restore(settingFromEntries(entries)!);
  assert.equal(
    resumed.shouldHandoff({ tokens: 140000, contextWindow: 272000 }),
    true,
  );
  assert.deepEqual(resumed.setting(), { enabled: true, at: "50%" });
});

test("no setting to inherit when the session has none", () => {
  assert.equal(settingFromEntries([{ type: "message" }]), undefined);
  assert.equal(
    settingFromEntries([
      { type: "custom", customType: AUTO_ENTRY_TYPE, data: "nope" },
    ]),
    undefined,
  );
  assert.equal(
    new AutoHandoff({ enabled: false, at: "80%" }).setting(),
    undefined,
  );
});

test("a forced threshold overrides the conversation and releasing restores it", () => {
  const auto = new AutoHandoff({ enabled: false, at: "80%" });
  auto.apply({ kind: "at", at: "90%" });
  auto.force("40%");
  assert.equal(
    auto.shouldHandoff({ tokens: 120000, contextWindow: 272000 }),
    true,
  );
  // The conversation setting is untouched underneath: it is what stays persisted.
  assert.deepEqual(auto.setting(), { enabled: true, at: "90%" });
  auto.release();
  assert.equal(
    auto.shouldHandoff({ tokens: 120000, contextWindow: 272000 }),
    false,
  );
  assert.equal(
    auto.shouldHandoff({ tokens: 250000, contextWindow: 272000 }),
    true,
  );

  // Forcing over an auto that was off leaves it off again after the release.
  const off = new AutoHandoff({ enabled: false, at: "80%" });
  off.force("40%");
  assert.equal(
    off.shouldHandoff({ tokens: 120000, contextWindow: 272000 }),
    true,
  );
  off.release();
  assert.equal(
    off.shouldHandoff({ tokens: 271000, contextWindow: 272000 }),
    false,
  );
  // Forcing without a threshold falls back to the default.
  off.force();
  assert.equal(
    off.shouldHandoff({ tokens: 220000, contextWindow: 272000 }),
    true,
  );
});

test("the indicator shows the live threshold only while auto is on", () => {
  const auto = new AutoHandoff({ enabled: false, at: "80%" });
  assert.equal(auto.indicator(), undefined);
  auto.apply({ kind: "on" });
  assert.equal(auto.indicator(), "auto-handoff@80%");
  auto.apply({ kind: "at", at: "150k" });
  assert.equal(auto.indicator(), "auto-handoff@150k");
  auto.force("40%");
  assert.equal(auto.indicator(), "auto-handoff@40%");
  auto.release();
  auto.apply({ kind: "off" });
  assert.equal(auto.indicator(), undefined);
});
