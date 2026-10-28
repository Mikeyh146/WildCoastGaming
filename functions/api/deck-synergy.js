// POST /api/deck-synergy
// Body: { commander: {name, type_line, oracle_text, color_identity}, cards: [{name, type_line, oracle_text, cmc, quantity}] }
// Requires env.ANTHROPIC_API_KEY (set as a Cloudflare secret).

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function buildPrompt(commander, cards) {
  const commanderBlock = `COMMANDER: ${commander.name}\nType: ${commander.type_line}\nColor identity: ${(commander.color_identity || []).join('') || 'Colorless'}\nRules text: ${truncate(commander.oracle_text, 600)}`;

  const cardLines = cards
    .filter(c => c.name !== commander.name)
    .map(c => `- ${c.name} | ${c.type_line || 'Unknown type'} | CMC ${c.cmc ?? '?'} | ${truncate(c.oracle_text, 280) || '(no rules text)'}`)
    .join('\n');

  return `You are an expert Magic: The Gathering Commander (EDH) deck analyst, reviewing a deck the way a sharp, honest playgroup friend would — specific and useful, not generic.

${commanderBlock}

DECK (${cards.length - 1} non-commander cards):
${cardLines}

Write a deck health check. For EVERY card listed, explain briefly and specifically how it interacts with THIS commander and THIS deck's apparent plan — not a generic description of the card. If a card does nothing special with this commander, say so plainly rather than inventing a connection.

Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:
{
  "grade": "one of: S, A, B, C, D, F",
  "summary": "2-3 sentence overall verdict on the deck's game plan and how well it supports the commander",
  "strengths": ["short bullet", "short bullet", "short bullet"],
  "weaknesses": ["short bullet", "short bullet", "short bullet"],
  "cards": [
    { "name": "exact card name as given", "role": "short role label e.g. Ramp, Removal, Card Draw, Win Condition, Synergy Piece, Protection, Filler", "synergyNote": "one specific sentence on how this card works with the commander or the deck's plan" }
  ]
}

Every card in the DECK list above must appear exactly once in "cards". Keep synergyNote genuinely specific — reference the actual mechanic, not boilerplate.`;
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'AI synergy analysis is not configured on this server yet.' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { commander, cards } = body;
  if (!commander || !Array.isArray(cards) || !cards.length) {
    return new Response(JSON.stringify({ error: 'Missing commander or cards.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const prompt = buildPrompt(commander, cards);

  
  let aiRes;
  console.log("DECK SYNERGY: reached AI request section");
  try {
    console.log("DECK SYNERGY: sending request to Anthropic");
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
      console.log("DECK SYNERGY: Anthropic responded", { status: aiRes.status });
    });
  } catch (e) {
    console.error('Anthropic fetch failed', {
      name: e?.name || 'UnknownError',
      message: String(e?.message || e).slice(0, 500),
    });

    return new Response(
      JSON.stringify({
        error: 'Could not reach the AI analysis service.',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }



if (!aiRes.ok) {
  const errText = await aiRes.text().catch(() => '');

  console.error('Anthropic API error', {
    status: aiRes.status,
    detail: errText.slice(0, 1000)
  });

  return new Response(
    JSON.stringify({
      error: `AI service returned an error (${aiRes.status}).`,
      detail: errText.slice(0, 1000)
    }),
    {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

  const aiData = await aiRes.json();
  const rawText = (aiData.content || []).map(block => block.text || '').join('').trim();

  let parsed;
  try {
    const cleaned = rawText.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'The AI response could not be parsed as JSON.', raw: rawText.slice(0, 500) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify(parsed), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
