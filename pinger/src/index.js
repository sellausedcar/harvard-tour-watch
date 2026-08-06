// Two independent legs run on every cron firing:
//
//   dispatchCheck  — POSTs workflow_dispatch, and GitHub Actions does the scrape.
//                    The original path. Unchanged.
//   fallbackCheck  — scrapes and pushes to ntfy from inside the Worker, with no
//                    GitHub involvement at all.
//
// Added 2026-08-06, during a GitHub Actions outage (incident opened 15:22Z) that
// left the watcher unable to get runners for hours: jobs queued ~15 min, ran zero
// steps, then were cancelled. The Worker itself never faltered — it fired 47 of 48
// slots on time — so the checking moved to the half that was still up.
//
// The point is redundancy, not replacement. Before, Cloudflare AND GitHub both had
// to be healthy for a check to happen; now either one suffices. Legs are isolated
// from each other so a bug in the new one cannot stop the proven one from firing.

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBothLegs(env));
  },
};

async function runBothLegs(env) {
  const legs = ["dispatch", "fallback"];
  const results = await Promise.allSettled([dispatchCheck(env), fallbackCheck(env)]);

  // allSettled swallows rejections, which would otherwise surface as Worker
  // errors. Log them so `wrangler tail` still shows a failing leg.
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`${legs[i]} leg failed: ${r.reason}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Leg 1: dispatch to GitHub Actions (original)
// ---------------------------------------------------------------------------

async function dispatchCheck(env) {
  const url =
    "https://api.github.com/repos/sellausedcar/harvard-tour-watch/actions/workflows/watch.yml/dispatches";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_PAT}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "harvard-tour-watch-pinger (Cloudflare Worker)",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    console.error(`workflow_dispatch failed: HTTP ${res.status} ${res.statusText} — ${body}`);
    throw new Error(`GitHub workflow_dispatch failed: ${res.status}`);
  }

  console.log(`workflow_dispatch ok: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Leg 2: scrape + notify from the Worker (GitHub-independent)
// ---------------------------------------------------------------------------

const ORGANIZER_URL =
  "https://www.eventbrite.com/o/harvard-university-visitor-center-30492393010";

// Matching check_tours.py's UA. Not a browser-impersonation trick — it is the
// same client identity the Actions leg has always presented, kept identical so
// the two legs cannot get different treatment from Eventbrite.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Built fresh per call rather than held module-global: a /g regex carries
// lastIndex, and Worker isolates are reused across cron firings.
const EVENT_PATTERN = "https://www\\.eventbrite\\.com/e/[a-z0-9-]*tickets-(\\d+)";
const LD_PATTERN = '<script[^>]*type="application/ld\\+json"[^>]*>([\\s\\S]*?)<\\/script>';

const STATE_KEY = "known_event_ids";
const RETRY_DELAY_MS = 30_000;

class WatcherError extends Error {}

async function fallbackCheck(env) {
  if (!env.TOUR_STATE) {
    console.error("fallback: TOUR_STATE KV binding missing — leg disabled");
    return;
  }
  // Checked up front: if we cannot notify, we cannot even report being broken.
  // Mirrors check_tours.py's "watcher misconfigured" gate.
  const topicError = topicProblem(env.NTFY_TOPIC);
  if (topicError) {
    console.error(`fallback: ${topicError} — cannot notify, leg disabled`);
    return;
  }

  let found;
  try {
    found = await currentEventIds();
  } catch (err) {
    console.error(`fallback: ${err.message}`);
    // Fail loudly. A silent phone must never be mistaken for "no new dates".
    await push(env, {
      title: "Harvard tour watcher is broken (Worker leg)",
      body:
        `${err.message}\n` +
        "The Worker-side check could not read the organizer page. " +
        "If the Actions leg is also failing, the watcher is not trustworthy.",
      priority: "high",
    }).catch((e) => console.error(`fallback: could not even push: ${e.message}`));
    return;
  }

  const state = await loadState(env);
  const known = new Set(state.known_event_ids || []);
  const fresh = [...found].filter((id) => !known.has(id));

  if (fresh.length === 0) {
    console.log(`fallback: no new tour weeks (${known.size} known)`);
    return;
  }

  for (const id of fresh) {
    const detail = await describeEvent(id).catch((err) => {
      // Degraded body beats no notification: the point of this leg is that the
      // phone rings. The link alone is actionable.
      console.error(`fallback: could not describe ${id}: ${err.message}`);
      return null;
    });
    const url = detail?.url || `https://www.eventbrite.com/e/tickets-${id}`;
    const body = detail
      ? `${detail.name} is ${detail.bookable ? "now bookable" : "listed but NOT bookable"}` +
        (detail.window ? ` (${detail.window})` : "")
      : `A new tour week was published (event ${id}) — details could not be read.`;

    await push(env, {
      title: "New Harvard tour dates",
      body,
      priority: "high",
      click: url,
    });
    console.log(`fallback PUSHED: ${body}`);
  }

  // Only reached if every push above succeeded — a throw skips the write, so the
  // next firing retries rather than marking the week seen. Same invariant as
  // check_tours.py's notify_new.
  //
  // UNION, never replacement. The organizer page lists only current and future
  // weeks (one, as of 08-06) while state is an accumulating archive (four).
  // Writing `found` alone would silently drop every past week.
  await saveState(env, new Set([...known, ...found]));
}

async function currentEventIds(attempts = 2, delayMs = RETRY_DELAY_MS) {
  // A single bad read is not evidence of breakage — see the 07-31 incident,
  // where the page briefly rendered with no events and self-healed. Real
  // breakage fails every attempt, so this does not weaken detection.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await currentEventIdsOnce();
    } catch (err) {
      if (attempt === attempts) throw err;
      console.error(
        `fallback: attempt ${attempt}/${attempts} failed (${err.message}); ` +
        `retrying in ${delayMs / 1000}s`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function currentEventIdsOnce() {
  const html = await fetchText(ORGANIZER_URL);
  const ids = new Set();
  for (const m of html.matchAll(new RegExp(EVENT_PATTERN, "g"))) ids.add(m[1]);
  if (ids.size === 0) {
    throw new WatcherError("organizer page listed zero events");
  }
  return ids;
}

async function describeEvent(id) {
  // Only runs when a genuinely new id appears — about once a week — so its cost
  // stays off the every-5-minute hot path.
  const html = await fetchText(`https://www.eventbrite.com/e/tickets-${id}`);
  for (const m of html.matchAll(new RegExp(LD_PATTERN, "g"))) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    if (!data || (data["@type"] !== "Event" && data["@type"] !== "MusicEvent")) continue;

    let offers = data.offers || [];
    if (!Array.isArray(offers)) offers = [offers];
    const availability = String(
      offers.find((o) => o && o.availability)?.availability || ""
    ).split("/").pop();

    return {
      name: data.name || `Event ${id}`,
      window: prettyWindow(data.startDate, data.endDate),
      bookable: availability.toLowerCase() === "instock",
      url: data.url || `https://www.eventbrite.com/e/tickets-${id}`,
    };
  }
  throw new WatcherError(`no Event JSON-LD found for ${id}`);
}

function prettyWindow(startIso, endIso) {
  // "Mon 8/10 - Fri 8/14". Formats the calendar date as written in the ISO
  // string, ignoring its offset, so the weekday cannot drift a day either way.
  const fmt = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return null;
    const [, y, mo, d] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, 12));
    const dow = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    return `${dow} ${+mo}/${+d}`;
  };
  const a = fmt(startIso);
  const b = fmt(endIso);
  return a && b ? `${a} - ${b}` : "";
}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA } });
  } catch (err) {
    throw new WatcherError(`could not fetch ${url}: ${err.message}`);
  }
  // fetch() does not throw on 4xx/5xx the way urlopen does. Without this an
  // Eventbrite 403 — which has happened, on 08-01 — would fall through and be
  // parsed as an empty page.
  if (!res.ok) {
    throw new WatcherError(`could not fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function loadState(env) {
  const raw = await env.TOUR_STATE.get(STATE_KEY);
  if (!raw) return { known_event_ids: [] };
  try {
    return JSON.parse(raw);
  } catch {
    throw new WatcherError("KV state is not valid JSON — refusing to guess");
  }
}

async function saveState(env, ids) {
  // Same shape as known_events.json so the two legs' state stays diffable.
  await env.TOUR_STATE.put(
    STATE_KEY,
    JSON.stringify(
      { known_event_ids: [...ids].sort(), updated_at: new Date().toISOString() },
      null,
      2
    )
  );
}

// ntfy topics are a single path segment. A full URL pasted in by mistake would
// build https://ntfy.sh/https://ntfy.sh/<topic>, 404, and lose the notification
// — so reject it up front with a message that says what is wrong. The message
// deliberately never echoes the value: the topic is the credential.
function topicProblem(raw) {
  const topic = String(raw || "").trim();
  if (!topic) return "NTFY_TOPIC is not set";
  if (/[/\s]/.test(topic) || topic.includes(":")) {
    return "NTFY_TOPIC looks like a URL or has stray characters — it must be " +
      "only the segment after ntfy.sh/";
  }
  return null;
}

async function push(env, { title, body, priority = "default", click }) {
  const headers = {
    "Title": title,
    "Priority": priority,
    // Marks which leg fired, so a duplicate with the Actions leg is
    // recognisable rather than confusing.
    "Tags": "mag,worker",
  };
  if (click) headers["Click"] = click;

  let res;
  try {
    res = await fetch(`https://ntfy.sh/${String(env.NTFY_TOPIC).trim()}`, {
      method: "POST",
      headers,
      body,
    });
  } catch (err) {
    // Never interpolate the URL into an error: the topic IS the credential.
    throw new WatcherError(`ntfy push failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new WatcherError(`ntfy push failed: HTTP ${res.status} ${res.statusText}`);
  }
}
