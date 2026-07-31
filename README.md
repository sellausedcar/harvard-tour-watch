# harvard-tour-watch

Watches the [Harvard University Visitor Center Eventbrite page](https://www.eventbrite.com/o/harvard-university-visitor-center-30492393010)
and pushes a phone notification when a **new week of tour dates** is published.

The organizer lists the "Official In-Person Historical Tour of Harvard" one week at a time, as a
separate Eventbrite event named e.g. *"Week of 07/13"*. So detecting newly-bookable dates is just:
diff the set of event IDs on the organizer page against the ones already seen.

## How it runs

A Cloudflare Worker (`pinger/`) fires on a cron every 5 minutes and dispatches
`.github/workflows/watch.yml` through the GitHub API. The workflow deliberately has no `schedule:`
trigger of its own — GitHub's scheduler fires at unpredictable times and would double up checks
alongside the pinger. Each dispatched run executes:

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

The workflow commits using the `GITHUB_TOKEN` that GitHub injects automatically — scoped to this
repository, expiring when the job ends. `NTFY_TOPIC` (the notification channel name) is an encrypted
repo secret; it is never written in the code and never reaches stdout, stderr, or a run log, which
matters because this repo is public and so are its Actions logs.

One long-lived credential does exist: the Cloudflare Worker holds a GitHub PAT (`GH_PAT`, a Worker
secret) so it can dispatch the workflow. Dispatching needs only `actions: write` on this one
repository — keep it fine-grained and scoped exactly that narrowly, and nothing else.

The narrowness is the whole point. An earlier version ran on a cloud agent that required an
account-wide token with `repo` scope over every repository the account could see, and that is the
reason that version was scrapped.

## Notes

- `check_tours.py` is stdlib-only, so the runner needs no `pip install`.
- Event URLs change weekly and are **re-discovered every run** — never hardcoded.
- Availability comes from the JSON-LD `AggregateOffer` block on each event page. Per-timeslot seat
  counts are deliberately not scraped: Eventbrite loads those over an authenticated XHR that isn't
  reachable without a real browser.
- The 5-minute cadence depends on this repo being **public**, where Actions minutes are free and
  unlimited. Private repos get 2,000 min/month on the Free plan and every job rounds up to a whole
  minute, so 5-minute checks would exhaust the month's quota in about a week — after which the
  workflow simply stops being runnable and the watcher goes *quietly* dead, which is the one failure
  mode this project is built to prevent. **If this repo is ever made private, drop the Worker cron
  back to `7,37 * * * *` in the same sitting.**

Run `python check_tours.py` with no flags to just print what's currently listed.
