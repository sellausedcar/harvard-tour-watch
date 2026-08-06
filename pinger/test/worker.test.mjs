// Runs the REAL pinger Worker (src/index.js) in workerd via Miniflare, with real
// KV and every outbound request intercepted by outboundService. Nothing here
// touches the network, the deployed Worker, GitHub, Eventbrite, or ntfy.

//
//   npm test
//
// miniflare resolves through wrangler's own dependency tree — no extra install.
// The fixture is a real capture of the organizer page (2026-08-06, 142 KiB),
// kept verbatim so the ID extraction is exercised against Eventbrite's actual
// markup rather than a hand-written approximation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const SCRIPT = fileURLToPath(new URL("../src/index.js", import.meta.url));
const HTML = readFileSync(new URL("./fixtures/organizer.html", import.meta.url), "utf8");

const ORIGIN_STATE = {
  known_event_ids: [
    "1993626882673", "1994242069714", "1994982796247", "1996172516733",
  ],
  updated_at: "2026-07-31T12:16:26+00:00",
};

const NEW_ID = "1999000111222";
const HTML_WITH_NEW_WEEK = HTML.replace(
  "https://www.eventbrite.com/e/official-in-person-historical-tour-of-harvard-week-of-083-tickets-1996172516733",
  "https://www.eventbrite.com/e/official-in-person-historical-tour-of-harvard-week-of-083-tickets-1996172516733\"" +
  " href=\"https://www.eventbrite.com/e/official-in-person-historical-tour-of-harvard-week-of-0810-tickets-" + NEW_ID
);

const eventLd = (id) => `<html><head>
<script type="application/ld+json">{
  "@type": "Event",
  "name": "Official In-Person Historical Tour of Harvard - Week of 08/10",
  "startDate": "2026-08-10T09:00:00-04:00",
  "endDate": "2026-08-14T16:00:00-04:00",
  "url": "https://www.eventbrite.com/e/week-of-0810-tickets-${id}",
  "offers": { "@type": "AggregateOffer", "availability": "http://schema.org/InStock" }
}</script></head><body></body></html>`;

const TOPIC = "unit-test-topic-not-real";
const ORGANIZER_PATH = "/o/harvard-university-visitor-center-30492393010";

async function run({
  seed,
  organizerHtml = HTML,
  organizerStatus = 200,
  githubStatus = 204,
  eventStatus = 200,
  topic = TOPIC,
}) {
  const pushes = [];
  const unmocked = [];

  const mf = new Miniflare({
    modules: true,
    scriptPath: SCRIPT,
    compatibilityDate: "2026-07-24",
    kvNamespaces: ["TOUR_STATE"],
    bindings: { NTFY_TOPIC: topic, GH_PAT: "fake-pat-never-used" },
    outboundService: async (request) => {
      const url = new URL(request.url);

      if (url.hostname === "api.github.com") {
        // 204 is a null-body status — new Response("", {status:204}) throws.
        return new Response(null, { status: githubStatus });
      }
      if (url.hostname === "www.eventbrite.com" && url.pathname === ORGANIZER_PATH) {
        return new Response(organizerStatus === 200 ? organizerHtml : "Forbidden",
          { status: organizerStatus });
      }
      if (url.hostname === "www.eventbrite.com" && url.pathname.startsWith("/e/tickets-")) {
        const id = url.pathname.replace("/e/tickets-", "");
        return new Response(eventStatus === 200 ? eventLd(id) : "boom",
          { status: eventStatus });
      }
      if (url.hostname === "ntfy.sh") {
        pushes.push({
          path: url.pathname,
          headers: Object.fromEntries(request.headers), // keys are lowercased
          body: await request.text(),
        });
        return new Response("ok");
      }
      unmocked.push(request.url);
      return new Response("unmocked", { status: 599 });
    },
  });

  const kv = await mf.getWorker && await mf.getKVNamespace("TOUR_STATE");
  if (seed) await kv.put("known_event_ids", JSON.stringify(seed));

  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "1-59/5 * * * THU,FRI" });

  const raw = await kv.get("known_event_ids");
  await mf.dispose();
  return { pushes, unmocked, state: raw ? JSON.parse(raw) : null };
}

// ---------------------------------------------------------------------------

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail !== undefined) console.log(`        got: ${detail}`); }
}

console.log("\n[1] seeded KV, no new week — the every-5-min case");
{
  const { pushes, state, unmocked } = await run({ seed: ORIGIN_STATE });
  check("no push", pushes.length === 0, pushes.length);
  check("state untouched (4 ids)", state.known_event_ids.length === 4,
    JSON.stringify(state.known_event_ids));
  check("no unmocked requests escaped", unmocked.length === 0, JSON.stringify(unmocked));
}

console.log("\n[2] UNSEEDED KV — the trap the seeding step prevents");
{
  const { pushes, state } = await run({ seed: null });
  check("exactly 1 spurious push", pushes.length === 1, pushes.length);
  check("state now 1 id", state.known_event_ids.length === 1,
    JSON.stringify(state.known_event_ids));
}

console.log("\n[3] NEW WEEK published — the case that matters");
{
  const { pushes, state } = await run({ seed: ORIGIN_STATE, organizerHtml: HTML_WITH_NEW_WEEK });
  check("exactly 1 push", pushes.length === 1, pushes.length);
  const p = pushes[0] || { headers: {} };
  check("posted to the topic path", p.path === `/${TOPIC}`, p.path);
  check("title is the new-dates alert", p.headers.title === "New Harvard tour dates",
    JSON.stringify(p.headers.title));
  check("body has name + bookable + window",
    /Week of 08\/10 is now bookable \(Mon 8\/10 - Fri 8\/14\)/.test(p.body || ""),
    JSON.stringify(p.body));
  check("Click header links to the event", /tickets-1999000111222/.test(p.headers.click || ""),
    JSON.stringify(p.headers.click));
  check("priority high", p.headers.priority === "high", JSON.stringify(p.headers.priority));
  check("tagged as the worker leg", /worker/.test(p.headers.tags || ""),
    JSON.stringify(p.headers.tags));
  // The bug the CPU measurement caught: state must be known UNION found.
  const ids = state.known_event_ids;
  check("state is UNION — 5 ids, no past week dropped",
    ids.length === 5 && ORIGIN_STATE.known_event_ids.every((i) => ids.includes(i))
      && ids.includes(NEW_ID),
    JSON.stringify(ids));
  check("topic absent from stored state", !JSON.stringify(state).includes(TOPIC));
}

console.log("\n[4] dispatch leg FAILS (GitHub 500) — legs must be isolated");
{
  const { pushes, state } = await run({
    seed: ORIGIN_STATE, organizerHtml: HTML_WITH_NEW_WEEK, githubStatus: 500,
  });
  check("fallback still pushed despite dispatch failure", pushes.length === 1, pushes.length);
  check("state still advanced to 5", state.known_event_ids.length === 5,
    JSON.stringify(state.known_event_ids));
}

console.log("\n[5] event page unreadable — degraded body beats no notification");
{
  const { pushes, state } = await run({
    seed: ORIGIN_STATE, organizerHtml: HTML_WITH_NEW_WEEK, eventStatus: 500,
  });
  check("still pushed", pushes.length === 1, pushes.length);
  check("body names the event and admits the gap",
    /new tour week was published/.test(pushes[0]?.body || "")
      && (pushes[0]?.body || "").includes(NEW_ID),
    JSON.stringify(pushes[0]?.body));
  check("still links somewhere usable", /tickets-1999000111222/.test(pushes[0]?.headers.click || ""),
    JSON.stringify(pushes[0]?.headers.click));
  check("state still advanced", state.known_event_ids.length === 5,
    JSON.stringify(state.known_event_ids));
}

console.log("\n[6] Eventbrite 403 — must alert, never stay silent (waits 30s for the retry)");
{
  const t0 = Date.now();
  const { pushes, state } = await run({ seed: ORIGIN_STATE, organizerStatus: 403 });
  check("exactly 1 broken-watcher push", pushes.length === 1, pushes.length);
  check("titled as broken", /is broken/.test(pushes[0]?.headers.title || ""),
    JSON.stringify(pushes[0]?.headers.title));
  check("names the 403", /403/.test(pushes[0]?.body || ""), JSON.stringify(pushes[0]?.body));
  check("topic not leaked into the alert body", !(pushes[0]?.body || "").includes(TOPIC));
  check("state NOT advanced on failure", state.known_event_ids.length === 4,
    JSON.stringify(state.known_event_ids));
  check("retried once before alerting (~30s elapsed)", Date.now() - t0 >= 29_000,
    `${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

console.log("\n[7] NTFY_TOPIC misconfigured — must refuse, not fire doomed requests");
{
  // Stray whitespace is survivable and must not break the push.
  const padded = await run({
    seed: ORIGIN_STATE, organizerHtml: HTML_WITH_NEW_WEEK, topic: `  ${TOPIC}\n`,
  });
  check("whitespace around the topic is trimmed, push still lands",
    padded.pushes.length === 1 && padded.pushes[0].path === `/${TOPIC}`,
    `${padded.pushes.length} push(es), path ${padded.pushes[0]?.path}`);

  // A pasted full URL must be caught, not turned into ntfy.sh/https://ntfy.sh/…
  const urlPasted = await run({
    seed: ORIGIN_STATE,
    organizerHtml: HTML_WITH_NEW_WEEK,
    topic: `https://ntfy.sh/${TOPIC}`,
  });
  check("full URL rejected — no request attempted", urlPasted.pushes.length === 0,
    urlPasted.pushes.length);
  check("nothing escaped to an unmocked host", urlPasted.unmocked.length === 0,
    JSON.stringify(urlPasted.unmocked));
  check("state NOT advanced when the leg is disabled",
    urlPasted.state.known_event_ids.length === 4,
    JSON.stringify(urlPasted.state.known_event_ids));

  // Empty topic: nothing can be notified, not even brokenness.
  const empty = await run({ seed: ORIGIN_STATE, organizerHtml: HTML_WITH_NEW_WEEK, topic: "" });
  check("empty topic disables the leg cleanly", empty.pushes.length === 0, empty.pushes.length);
  check("state untouched", empty.state.known_event_ids.length === 4,
    JSON.stringify(empty.state.known_event_ids));
}

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
