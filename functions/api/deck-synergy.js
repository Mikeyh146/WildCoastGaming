// Cloudflare Pages Function: POST /api/deck-synergy
// Enforces the per-user AI review allowance in Supabase before calling Anthropic.
// Required Cloudflare secrets/variables:
//   ANTHROPIC_API_KEY (secret)
//   SUPABASE_SECRET_KEY (secret, newer sb_secret_ format)
//   SUPABASE_URL (variable)
//   SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY (public key, variable)

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const MODEL_VERSION = 'claude-haiku-5-5';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function truncate(value, max) {
  if (typeof value !== 'string' || !value) return '';
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function buildPrompt(commander, cards) {
  const commanderBlock = `COMMANDER: ${commander.name}\nType: ${commander.type_line || 'Unknown type'}\nColor identity: ${(commander.color_identity || []).join('') || 'Colorless'}\nRules text: ${truncate(commander.oracle_text, 600)}`;
  const cardLines = cards
    .filter(card => card.name.toLowerCase() !== commander.name.toLowerCase())
    .map(card => `- ${card.name} | ${card.type_line || 'Unknown type'} | CMC ${card.cmc ?? '?'} | Quantity ${card.quantity ?? 1} | ${truncate(card.oracle_text, 280) || '(no rules text)'}`)
    .join('\n');

  return `You are an expert Magic: The Gathering Commander (EDH) deck analyst, reviewing a deck the way a sharp, honest playgroup friend would: specific and useful, not generic.

${commanderBlock}

DECK (${cards.filter(card => card.name.toLowerCase() !== commander.name.toLowerCase()).length} listed card entries):
${cardLines}

Write a deck health check. For EVERY card listed, explain briefly and specifically how it interacts with THIS commander and THIS deck's apparent plan, not a generic description. If a card does nothing special with this commander, say so plainly rather than inventing a connection.

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

Every card in the DECK list above must appear exactly once in "cards". Keep synergyNote genuinely specific: reference the actual mechanic, not boilerplate.`;
}

function parseAiJson(rawText) {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

function serviceHeaders(secretKey) {
  // New sb_secret_ keys are not JWTs: send them in apikey only, never as a Bearer token.
  return {
    apikey: secretKey,
    'Content-Type': 'application/json'
  };
}

async function quotaRpc(env, functionName, userId) {
  const baseUrl = env.SUPABASE_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: serviceHeaders(env.SUPABASE_SECRET_KEY),
    body: JSON.stringify({ p_user_id: userId })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`Supabase quota RPC ${functionName} failed`, {
      status: response.status,
      detail: detail.slice(0, 500)
    });
    throw new Error('Review allowance could not be checked. Please try again shortly.');
  }

  return response.json().catch(() => null);
}

async function releaseQuota(env, userId) {
  try {
    await quotaRpc(env, 'release_new_analysis', userId);
  } catch (error) {
    // Fail closed: if release fails, the reservation remains counted against the allowance.
    console.error('Could not release reserved review allowance', String(error?.message || error));
  }
}

export async function onRequestPost({ request, env }) {
  const supabaseUrl = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !publishableKey || !secretKey) {
    return json({ error: 'Server configuration is incomplete. Check the Supabase URL, publishable key, and SUPABASE_SECRET_KEY Cloudflare secret.' }, 503);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return json({ error: 'Please sign in to use the deck analyser.' }, 401);
  }

  let authResponse;
  try {
    authResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${tokenMatch[1]}`
      }
    });
  } catch (error) {
    console.error('Supabase session verification request failed', String(error?.message || error));
    return json({ error: 'Could not verify your sign-in session. Please try again.' }, 502);
  }

  if (!authResponse.ok) {
    return json({ error: 'Your sign-in session is invalid or has expired. Please sign in again.' }, 401);
  }

  let user;
  try {
    user = await authResponse.json();
  } catch {
    return json({ error: 'Could not verify your sign-in session. Please sign in again.' }, 401);
  }
  if (!user?.id) return json({ error: 'Could not identify the signed-in account.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const commander = body?.commander;
  const cards = body?.cards;
  if (!commander || typeof commander.name !== 'string' || !commander.name.trim() || !Array.isArray(cards) || cards.length < 1) {
    return json({ error: 'Missing commander or cards.' }, 400);
  }
  if (cards.length > 100) return json({ error: 'This review contains too many cards. Please submit no more than 100 card entries at once.' }, 400);
  if (commander.name.length > 200 || cards.some(card => !card || typeof card.name !== 'string' || !card.name.trim() || card.name.length > 200)) {
    return json({ error: 'One or more card names are invalid.' }, 400);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'AI synergy analysis is not configured on this server yet.' }, 501);
  }

  let prompt;
  try {
    prompt = buildPrompt(commander, cards);
  } catch (error) {
    console.error('Could not build deck analysis prompt', String(error?.message || error));
    return json({ error: 'Could not prepare this deck for analysis.' }, 400);
  }

  // Reserve atomically before spending money on the AI request. The RPC checks
  // the user's server-controlled plan and counts both completed and in-flight reviews.
  let reserved = false;
  try {
    reserved = await quotaRpc(env, 'reserve_new_analysis', user.id) === true;
  } catch (error) {
    return json({ error: error?.message || 'Review allowance could not be checked. Please try again shortly.' }, 503);
  }

  if (!reserved) {
    return json({
      error: 'You have used all available AI reviews for your current plan.',
      code: 'REVIEW_LIMIT_REACHED',
      action: 'Contact the Wild Coast Gaming administrator if you need an additional review.'
    }, 429);
  }

  let quotaFinalized = false;
  try {
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL_VERSION,
        max_tokens: 8000,
        thinking: { type: 'disabled' },
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiResponse.ok) {
      const detail = await aiResponse.text().catch(() => '');
      console.error('Anthropic API error', { status: aiResponse.status, detail: detail.slice(0, 1000) });
      await releaseQuota(env, user.id);
      quotaFinalized = true;
      return json({ error: `AI service returned an error (${aiResponse.status}). Please try again.` }, 502);
    }

    let aiData;
    try {
      aiData = await aiResponse.json();
    } catch {
      await releaseQuota(env, user.id);
      quotaFinalized = true;
      return json({ error: 'Could not read the AI response. Your review allowance has not been used.' }, 502);
    }

    const rawText = (aiData.content || []).map(block => typeof block.text === 'string' ? block.text : '').join('').trim();
    if (!rawText) {
      console.error('Anthropic returned no analysis text', { stop_reason: aiData.stop_reason || null });
      await releaseQuota(env, user.id);
      quotaFinalized = true;
      return json({ error: 'The AI service returned no analysis text. Your review allowance has not been used.' }, 502);
    }

    let parsed;
    try {
      parsed = parseAiJson(rawText);
    } catch (error) {
      console.error('Anthropic response was not valid JSON', {
        message: String(error?.message || error).slice(0, 300),
        responsePreview: rawText.slice(0, 300)
      });
      await releaseQuota(env, user.id);
      quotaFinalized = true;
      return json({ error: 'The AI response could not be read. Your review allowance has not been used.' }, 502);
    }

    // The AI review succeeded, so turn the reservation into a completed review.
    // If finalization fails, do not release the reservation: fail closed to avoid
    // allowing repeated requests to bypass the limit.
    try {
      await quotaRpc(env, 'complete_new_analysis', user.id);
      quotaFinalized = true;
    } catch (error) {
      console.error('AI review succeeded but quota finalization failed; reservation retained', String(error?.message || error));
    }

    return json(parsed, 200);
  } catch (error) {
    console.error('Deck synergy request failed', String(error?.message || error));
    if (!quotaFinalized) await releaseQuota(env, user.id);
    return json({ error: 'The deck analysis could not be completed. Please try again.' }, 502);
  }
}
