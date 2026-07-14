# harvard-tour-watch

Watches the [Harvard University Visitor Center Eventbrite page](https://www.eventbrite.com/o/harvard-university-visitor-center-30492393010)
and pushes a phone notification when a **new week of tour dates** is published.

The organizer lists the "Official In-Person Historical Tour of Harvard" one week at a time, as a
separate Eventbrite event named e.g. *"Week of 07/13"*. So detecting newly-bookable dates is just:
diff the set of event IDs on the organizer page against the ones already seen.

## How it runs

A GitHub Actions workflow (`.github/workflows/watch.yml`) runs every 30 minutes and executes:

```bash
NTFY_TOPIC=<secret> python check_tours.py --notify
```

- **No new event IDs** → exits quietly. No notification, no commit.
- **A new event ID** → pushes to [ntfy](https://ntfy.sh) with the week, date range, whether it's
  bookable, and a link. Then commits the new ID to `known_events.json`.
- **Fetch or parse fails** → pushes a **"watcher is broken"** alert. Failure is loud on purpose: a
  quiet phone must never be ambiguous between "no new dates" and "the scraper died weeks ago."

State lives in `known_events.json`, committed back by the workflow, because each Actions run starts
from a fresh checkout with no memory of the last one.

## Credentials

By design, **nothing here holds a long-lived credential.** The workflow commits using the
`GITHUB_TOKEN` that GitHub injects automatically — scoped to this repository, expiring when the job
ends. The only secret is `NTFY_TOPIC` (the notification channel name), stored as an encrypted repo
secret.

This is deliberate: an earlier version ran on a cloud agent that required sharing an account-wide
GitHub token, which was the reason it was scrapped.

## Notes

- `check_tours.py` is stdlib-only, so the runner needs no `pip install`.
- Event URLs change weekly and are **re-discovered every run** — never hardcoded.
- Availability comes from the JSON-LD `AggregateOffer` block on each event page. Per-timeslot seat
  counts are deliberately not scraped: Eventbrite loads those over an authenticated XHR that isn't
  reachable without a real browser.
- The cron fires at `:07`/`:37` rather than `:00`/`:30` because GitHub delays or drops scheduled runs
  under load, which peaks at the top of the hour.

Run `python check_tours.py` with no flags to just print what's currently listed.
