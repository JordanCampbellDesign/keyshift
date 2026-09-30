// Sends people straight to the newest Keyshift zip, so the site never needs an edit after a release.
// GET /download        -> 302 to the zip on GitHub
// GET /download?info=1 -> {"version":"1.0.0","size":78937002,"url":"..."} for the page's version label
// If GitHub is slow or down, people land on the release page instead of an error.
const REPO = "JordanCampbellDesign/keyshift";
const FALLBACK = `https://github.com/${REPO}/releases/latest`;

async function latestZip() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "keyshift-site" };
  // Optional: a token raises GitHub's limit from 60 to 5,000 requests an hour. The edge cache below usually makes it unnecessary.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(4000) });
  if (!r.ok) return null;
  const release = await r.json();
  const zip = release.assets?.find((a) => a.name.endsWith(".zip"));
  return zip ? { version: release.tag_name.replace(/^v/, ""), size: zip.size, url: zip.browser_download_url } : null;
}

export default async function handler(req, res) {
  let zip = null;
  try { zip = await latestZip(); } catch {}

  if (zip) {
    // Cache at Vercel's edge for 10 minutes, and keep serving the last good answer for a day if GitHub fails.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400, stale-if-error=86400");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }

  if (req.query.info !== undefined) {
    res.status(zip ? 200 : 503).json(zip ?? { error: "GitHub didn't answer. Try again in a minute." });
    return;
  }
  res.redirect(302, zip ? zip.url : FALLBACK);
}
