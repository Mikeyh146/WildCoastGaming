/**
 * Wild Coast Gaming: public Moxfield deck import bridge
 * Deploy this file as a Cloudflare Worker. Then copy its workers.dev URL into
 * MOXFIELD_WORKER_URL near the top of Wild_Coast_Deck_Reviewer.html.
 * Public decks only. This worker does not need Moxfield login credentials.
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

function deckIdFromUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!/^(www\.)?moxfield\.com$/i.test(url.hostname) || !url.pathname.startsWith("/decks/")) return null;
  const id = url.pathname.split("/").filter(Boolean)[1];
  return id && /^[\w-]+$/.test(id) ? id : null;
}

function entriesFromBoard(board) {
  if (!board) return [];
  const source = board.cards && typeof board.cards === "object" ? board.cards : board;
  const out = [];
  for (const item of Object.values(source)) {
    if (!item || typeof item !== "object") continue;
    const card = item.card || item;
    const name = card.name || item.name;
    const quantity = Number(item.quantity ?? item.count ?? 1);
    if (name && Number.isFinite(quantity) && quantity > 0) {
      out.push({ name: String(name), quantity: Math.floor(quantity) });
    }
  }
  return out;
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return response({ error: "Use POST with JSON { url: \"https://www.moxfield.com/decks/...\" }." }, 405);
    let body;
    try { body = await request.json(); } catch { return response({ error: "Request body must be JSON." }, 400); }
    const id = deckIdFromUrl(body.url || "");
    if (!id) return response({ error: "That does not look like a public Moxfield deck URL." }, 400);

    // Moxfield may change its public API or rate-limit automated requests.
    const apiUrl = `https://api2.moxfield.com/v2/decks/all/${encodeURIComponent(id)}?includeBoards=true&includeTags=true&includePrimer=false`;
    let upstream;
    try {
      upstream = await fetch(apiUrl, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "WildCoastGaming-DeckReviewer/1.0",
          "Referer": "https://www.moxfield.com/"
        }
      });
    } catch {
      return response({ error: "Could not connect to Moxfield. Try again or paste an exported decklist." }, 502);
    }
    if (!upstream.ok) {
      return response({ error: `Moxfield returned HTTP ${upstream.status}. Check that the deck is public; Moxfield may also have changed or restricted its API.` }, 502);
    }
    let data;
    try { data = await upstream.json(); } catch { return response({ error: "Moxfield did not return valid deck data." }, 502); }

    const boards = data.boards || {};
    const commanderBoard = boards.commanders || boards.commander || data.commanders || data.commander;
    const mainBoard = boards.mainboard || boards.mainBoard || data.mainboard || data.mainBoard;
    const included = [];
    const commanderEntries = entriesFromBoard(commanderBoard);
    const mainEntries = entriesFromBoard(mainBoard);
    included.push(...commanderEntries, ...mainEntries);

    // Some response versions return a flatter board structure. Try other normal
    // deck boards only if mainboard/commander fields weren't found.
    if (!included.length) {
      for (const [key, value] of Object.entries(boards)) {
        if (/sideboard|maybeboard|considering|tokens/i.test(key)) continue;
        included.push(...entriesFromBoard(value));
      }
    }
    if (!included.length) {
      return response({ error: "Moxfield responded, but its decklist format was not recognised. Export/copy the decklist from Moxfield and paste it into the reviewer." }, 502);
    }

    const decklist = included.map(item => `${item.quantity} ${item.name}`).join("\n");
    const commander = commanderEntries[0]?.name || "";
    return response({ decklist, commander, cardCount: included.reduce((sum, item) => sum + item.quantity, 0) });
  }
};
