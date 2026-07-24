export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchCheck(env));
  },
};

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
