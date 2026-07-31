#!/usr/bin/env python3
"""Watch the Harvard Visitor Center Eventbrite page for newly published tour weeks.

The organizer publishes the historical tour one week at a time, as a separate
Eventbrite event named e.g. "Week of 07/13". Detecting new bookable dates is
therefore just: diff the set of event IDs on the organizer page against the set
we've already seen.

Run with --notify to diff against known_events.json, push any new weeks to ntfy,
and record them. Without it, just prints what's currently listed.

Stdlib only: the cloud sandbox gets no pip install.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ORGANIZER_URL = (
    "https://www.eventbrite.com/o/"
    "harvard-university-visitor-center-30492393010"
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
EVENT_RE = re.compile(r"https://www\.eventbrite\.com/e/[a-z0-9-]*tickets-(\d+)")
LD_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S
)

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "known_events.json")


class WatcherError(Exception):
    """Fetching or parsing failed — the watcher itself is broken."""


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        raise WatcherError("could not fetch %s: %s" % (url, exc))


def parse_event(html, url, event_id):
    """Pull name/dates/availability out of the event page's JSON-LD."""
    for blob in LD_RE.findall(html):
        try:
            data = json.loads(blob.strip())
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict) or data.get("@type") not in ("Event", "MusicEvent"):
            continue
        offers = data.get("offers") or []
        if isinstance(offers, dict):
            offers = [offers]
        availability = ""
        for offer in offers:
            if isinstance(offer, dict) and offer.get("availability"):
                availability = str(offer["availability"]).rsplit("/", 1)[-1]
                break
        return {
            "id": event_id,
            "name": data.get("name") or "",
            "start": data.get("startDate") or "",
            "end": data.get("endDate") or "",
            "availability": availability,
            "bookable": availability.lower() == "instock",
            "url": url,
        }
    raise WatcherError("no Event JSON-LD found on %s" % url)


def current_events():
    html = fetch(ORGANIZER_URL)
    seen, events = set(), []
    for match in EVENT_RE.finditer(html):
        url, event_id = match.group(0), match.group(1)
        if event_id in seen:
            continue
        seen.add(event_id)
        events.append(parse_event(fetch(url), url, event_id))
    if not events:
        raise WatcherError(
            "organizer page listed zero events — markup probably changed"
        )
    return events


def load_state():
    if not os.path.exists(STATE_PATH):
        return {"known_event_ids": []}
    with open(STATE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def save_state(known_ids):
    payload = {
        "known_event_ids": sorted(known_ids),
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def ntfy_topic():
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        raise WatcherError("NTFY_TOPIC is not set — nowhere to send the alert")
    return topic


def push(title, body, priority="default", click=None):
    headers = {
        "Title": title.encode("utf-8"),
        "Priority": priority,
    }
    if click:
        headers["Click"] = click
    req = urllib.request.Request(
        "https://ntfy.sh/%s" % ntfy_topic(),
        data=body.encode("utf-8"),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except OSError as exc:
        # urlopen raises URLError/HTTPError (both OSError) when ntfy is
        # unreachable. Without this the broken-watcher path below dies with an
        # unhandled traceback — the one path that most needs to fail cleanly.
        # Neither exception renders the URL in str(), so the topic stays out of
        # the message; keep it that way, as this text lands in a public log.
        raise WatcherError("ntfy push failed: %s" % exc)


def pretty_window(event):
    """'Mon 7/13 – Fri 7/17' from the ISO start/end, best effort."""
    try:
        start = datetime.fromisoformat(event["start"])
        end = datetime.fromisoformat(event["end"])
    except ValueError:
        return ""
    return "%s %d/%d - %s %d/%d" % (
        start.strftime("%a"), start.month, start.day,
        end.strftime("%a"), end.month, end.day,
    )


def notify_new(events):
    state = load_state()
    known = set(state.get("known_event_ids", []))
    new = [e for e in events if e["id"] not in known]

    if not new:
        print("no new tour weeks (%d known)" % len(known))
        return 0

    for event in new:
        window = pretty_window(event)
        status = "now bookable" if event["bookable"] else "listed but NOT bookable"
        body = "%s is %s%s" % (
            event["name"], status, " (%s)" % window if window else ""
        )
        push(
            "New Harvard tour dates",
            body,
            priority="high",
            click=event["url"],
        )
        print("PUSHED: %s" % body)

    save_state(known | {e["id"] for e in new})
    return len(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--notify",
        action="store_true",
        help="diff against known_events.json, push new weeks, update state",
    )
    args = ap.parse_args()

    # Check the topic up front. If it's missing we cannot alert about anything,
    # not even about being broken, so fail cleanly rather than mid-notification.
    if args.notify:
        try:
            ntfy_topic()
        except WatcherError as exc:
            sys.stderr.write("watcher misconfigured: %s\n" % exc)
            return 2

    try:
        events = current_events()
    except WatcherError as exc:
        # Fail loudly: a silent phone must never be mistaken for "no new dates".
        sys.stderr.write("watcher error: %s\n" % exc)
        if args.notify:
            try:
                push(
                    "Harvard tour watcher is broken",
                    "%s\nThe page structure may have changed — the watcher is "
                    "no longer trustworthy." % exc,
                    priority="high",
                )
            except WatcherError as push_exc:
                sys.stderr.write("could not even push: %s\n" % push_exc)
        return 2

    if args.notify:
        try:
            notify_new(events)
        except WatcherError as exc:
            # notify_new saves state only after every push succeeds, so a failed
            # push leaves known_events.json untouched and the next run retries.
            # Exiting 2 makes Actions email about it rather than failing quietly.
            sys.stderr.write("watcher error: %s\n" % exc)
            return 2
        return 0

    print(json.dumps(events, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
