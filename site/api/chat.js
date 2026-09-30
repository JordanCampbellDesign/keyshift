// Help chat for keyshift-extension.vercel.app.
// GET  /api/chat                        -> {"ai": true|false}  (false until ANTHROPIC_API_KEY is set in Vercel)
// POST /api/chat {"messages":[...]}     -> {"answer": "..."}
// Claude answers only from the site's own Help and Questions text, so the page stays the single source of truth.
// Without a key, the page answers from the same text in the browser.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_QUESTION = 500;   // characters per message
const MAX_TURNS = 8;        // messages of history sent to Claude
const PER_MINUTE = 8;       // requests per visitor per minute (best effort, per server instance)

// Turn the page's Help, Questions, feature, and install text into plain notes for the system prompt.
function loadKnowledge() {
  // index.html sits one folder up from this file, both locally and on Vercel.
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "index.html"), "utf8");
  const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const notes = [];
  for (const m of html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)) {
    notes.push(`Q: ${text(m[1])}\nA: ${text(m[2])}`);
  }
  for (const m of html.matchAll(/<div class="card feature">[\s\S]*?<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)) {
    notes.push(`Feature: ${text(m[1])}. ${text(m[2])}`);
  }
  const install = html.match(/<section id="install"[\s\S]*?<\/section>/);
  if (install) notes.push(`Install guide and keyboard shortcuts: ${text(install[0])}`);
  return notes.join("\n\n");
}

function buildSystem() {
  return `You answer questions on the website for Keyshift, a free, open source Chrome extension that changes the pitch and tempo of any tab's audio, loops sections, and splits songs into stems (vocals, drums, bass, other) on the user's computer.

Answer only from the notes below. If the notes don't cover the question, say you don't know, and suggest opening an issue on GitHub: https://github.com/JordanCampbellDesign/keyshift/issues/new/choose

How to write:
- Plain text only. No markdown, no headings, no bullet symbols, no bold.
- Short: 1 to 4 sentences, or numbered steps like "1. ... 2. ..." when there are steps.
- Write for a 16-year-old. Short common words. Start instructions with the verb.
- Friendly and calm. No em dashes.
- Use the exact names of buttons and settings from the notes.
- The download link is https://keyshift-extension.vercel.app/download
- Don't make up features, prices, or compatibility.

Notes:
${loadKnowledge()}`;
}

// Built on the first question, so a problem reading the page can never take down the status check.
let SYSTEM = null;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > PER_MINUTE;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ai: Boolean(client) });
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!client) return res.status(501).json({ error: "The AI helper isn't set up." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "That's a lot of questions at once. Wait a minute, then try again." });

  // Keep only well-formed, short turns, starting with the visitor.
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = raw
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }))
    .slice(-MAX_TURNS);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return res.status(400).json({ error: "Send a question." });

  try {
    SYSTEM ??= buildSystem();
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (response.stop_reason === "refusal") {
      return res.status(200).json({ answer: "I can only help with questions about Keyshift. Try asking about installing it or using it on a site." });
    }
    const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return res.status(200).json({ answer: answer || "Sorry, I don't have an answer for that. Try the Help section on this page." });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "The helper is busy. Try again in a minute." });
    if (error instanceof Anthropic.APIError) return res.status(502).json({ error: "The helper had a problem." });
    return res.status(500).json({ error: "The helper had a problem." });
  }
}
