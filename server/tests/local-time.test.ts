import assert from "node:assert/strict";
import test from "node:test";

import {
  Layout,
  LocalTime,
  formatTimeFallback,
  localTimeData,
  localTimeHtml,
} from "../src/web-templates/layout.js";

const instant = "2026-08-16T17:41:55.000Z";

test("LocalTime preserves the UTC instant for browser localization", () => {
  const html = String(LocalTime({ value: instant, format: "event" }));

  assert.match(html, /<time /);
  assert.match(html, /datetime="2026-08-16T17:41:55\.000Z"/);
  assert.match(html, /data-bf-local-time="event"/);
  assert.match(html, /data-bf-local-time-value="2026-08-16T17:41:55\.000Z"/);
  assert.match(html, /title="UTC: 2026-08-16T17:41:55\.000Z"/);
});

test("local time helpers support option labels and invalid fallbacks", () => {
  assert.deepEqual(localTimeData(instant, "short", "Last seen ", ")"), {
    "data-bf-local-time": "short",
    "data-bf-local-time-value": instant,
    "data-bf-local-time-prefix": "Last seen ",
    "data-bf-local-time-suffix": ")",
  });
  assert.equal(formatTimeFallback("not-a-date"), "not-a-date");
  assert.match(localTimeHtml("not-a-date"), />not-a-date<\/time>/);

  const hostile = String(LocalTime({ value: '\"><script>alert("x")</script>' }));
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
});

test("Layout localizes initial and HTMX-swapped timestamps", () => {
  const html = String(Layout({ title: "Time test", minimal: true, children: "" }));

  assert.match(html, /Intl\.DateTimeFormat\(undefined/);
  assert.match(html, /htmx:afterSwap/);
  assert.match(html, /htmx:oobAfterSwap/);
});
