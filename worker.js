/**
 * Mi bote — API (Cloudflare Worker + Workers KV)
 *
 *   GET  /api/state    -> { state }                (siempre sin caché)
 *   POST /api/action   -> { state, result }        body: { action, payload }
 *
 * App individual: no hay usuarios ni revisión. Las tareas suman al completarlas
 * y casi todo se puede deshacer. Las monedas se calculan AQUÍ, no en el navegador.
 *
 * Bindings / variables (ver wrangler.toml):
 *   BOTE_KV        (obligatorio) namespace de KV
 *   ASSETS         (automático)  archivos estáticos de /public
 *   APP_CODE       (opcional)    código de acceso; si existe, se exige en cada petición
 *   TZ_NAME        (opcional)    zona horaria para las fechas límite (por defecto Europe/Madrid)
 *   ALLOWED_ORIGIN (opcional)    solo si el frontend está en otro dominio
 */

const BASE = { easy: 10, medium: 25, hard: 50 };
const STATE_KEY = 'state';
const MAX_HISTORY = 300; // feed de actividad
const MAX_LOG = 2000; // registros permanentes
const MAX_PENALTY_TYPES = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Datos iniciales (todo editable desde la app)                        */
/* ------------------------------------------------------------------ */

const T = (title, difficulty, type = 'recurring') => ({ title, difficulty, type });

const SEED_TASKS = [
  T('Salir a correr', 'medium'),
  T('Ir a nadar', 'medium'),
  T('Practicar acuarelas', 'easy'),
  T('Editar vídeo', 'medium'),
  T('Hacer la comida', 'easy'),
  T('Ordenar el trastero', 'hard', 'once'),
];

const SEED_REWARDS = [
  { icon: '🍰', title: 'Algo rico para comer', description: 'Un antojo, sin remordimientos.', cost: 50 },
  { icon: '🛍️', title: 'Ir a Action', description: 'Paseo por la tienda y lo que me llame la atención.', cost: 100 },
  { icon: '🎨', title: 'Capricho de manualidades', description: 'Material nuevo para pintar o crear.', cost: 150 },
];

// Lista inicial de penalizaciones. Se marcan a mano; nada se detecta automáticamente.
const PENALTY_SEED = [{ title: 'Saltarme el día de correr', difficulty: 'medium' }];

function makeInitialState(now) {
  return {
    version: 1,
    coins: 0,
    totals: { earned: 0, spent: 0, penalized: 0 },
    tasks: SEED_TASKS.map((t) => ({
      id: crypto.randomUUID(),
      title: t.title,
      difficulty: t.difficulty,
      type: t.type,
      deadline: null,
      bonusPct: t.type === 'once' ? 50 : 0,
      archived: false,
      status: 'available', // available | done
      doneCount: 0,
      lastDoneAt: null,
    })),
    rewards: SEED_REWARDS.map((r) => ({ id: crypto.randomUUID(), ...r, archived: false, timesRedeemed: 0 })),
    penaltyTypes: PENALTY_SEED.map((x) => ({ id: crypto.randomUUID(), ...x })),
    history: [],
    completions: [], // tareas completadas
    redemptions: [], // recompensas canjeadas
    penalties: [], // penalizaciones marcadas
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function cleanText(value, max, label, required = true) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new HttpError(400, `Falta ${label}.`);
  return s.slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function todayIn(tz, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function cleanTask(input, base = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Tarea no válida.');
  const title = cleanText(input.title, 80, 'el nombre de la tarea');
  if (!BASE[input.difficulty]) throw new HttpError(400, 'Dificultad no válida.');
  if (!['recurring', 'once'].includes(input.type)) throw new HttpError(400, 'Tipo de tarea no válido.');
  let deadline = null;
  let bonusPct = 0;
  if (input.type === 'once' && input.deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) throw new HttpError(400, 'Fecha límite no válida.');
    deadline = input.deadline;
    bonusPct = clampInt(input.bonusPct, 0, 200, 50);
  }
  return { ...base, title, difficulty: input.difficulty, type: input.type, deadline, bonusPct };
}

function cleanReward(input, base = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Recompensa no válida.');
  const title = cleanText(input.title, 60, 'el título de la recompensa');
  const description = cleanText(input.description, 200, 'la descripción', false);
  const icon = cleanText(input.icon, 8, 'el icono', false) || '🎁';
  const cost = clampInt(input.cost, 1, 100000, NaN);
  if (!Number.isFinite(cost)) throw new HttpError(400, 'El coste debe ser un número de monedas.');
  return { ...base, title, description, icon, cost };
}

function cleanPenaltyType(input, base = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Penalización no válida.');
  const title = cleanText(input.title, 60, 'el nombre de la penalización');
  if (!BASE[input.difficulty]) throw new HttpError(400, 'Cantidad no válida.');
  return { ...base, title, difficulty: input.difficulty };
}

/** Monedas que vale una tarea si se completa HOY (el bonus depende de la fecha límite). */
function evaluateCoins(task, today) {
  const base = BASE[task.difficulty];
  const onTime = task.type === 'once' && !!task.deadline && task.bonusPct > 0 && today <= task.deadline;
  return { onTime, coins: onTime ? Math.round(base * (1 + task.bonusPct / 100)) : base };
}

function pushHistory(state, entry, now) {
  const e = { id: crypto.randomUUID(), at: now, ...entry };
  state.history.unshift(e);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  return e;
}

function pushLog(list, rec) {
  list.unshift(rec);
  if (list.length > MAX_LOG) list.length = MAX_LOG;
}

function markHistoryUndone(state, id) {
  const orig = state.history.find((x) => x.id === id);
  if (orig) orig.undone = true;
}

const find = (list, id, msg) => {
  const x = list.find((e) => e.id === id);
  if (!x) throw new HttpError(404, msg);
  return x;
};

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

function applyAction(state, action, p, now, today) {
  p = p || {};
  switch (action) {
    /* ---- Tareas ---- */
    case 'completeTask': {
      const t = find(state.tasks, p.taskId, 'Esa tarea ya no existe.');
      if (t.archived) throw new HttpError(409, 'Esa tarea está archivada.');
      if (t.status !== 'available') throw new HttpError(409, 'Esa tarea ya está completada.');
      const { onTime, coins } = evaluateCoins(t, today);
      const prevLastDoneAt = t.lastDoneAt;
      state.coins += coins;
      state.totals.earned += coins;
      t.doneCount += 1;
      t.lastDoneAt = now;
      t.status = t.type === 'recurring' ? 'available' : 'done';
      const h = pushHistory(state, { type: 'completed', title: t.title, coins }, now);
      pushLog(state.completions, {
        id: h.id, at: now, taskId: t.id, title: t.title, difficulty: t.difficulty,
        coins, onTime, prevLastDoneAt, undone: false,
      });
      return { coins, completionId: h.id };
    }

    case 'undoComplete': {
      const rec = find(state.completions, p.completionId, 'Esa tarea ya no está en el registro.');
      if (rec.undone) throw new HttpError(409, 'Esa tarea ya estaba deshecha.');
      if (state.coins < rec.coins) {
        throw new HttpError(409, `No se puede deshacer: ya has gastado esas monedas (faltan ${rec.coins - state.coins} en el bote).`);
      }
      rec.undone = true;
      rec.undoneAt = now;
      state.coins -= rec.coins;
      state.totals.earned = Math.max(0, state.totals.earned - rec.coins);
      const t = state.tasks.find((x) => x.id === rec.taskId);
      if (t) {
        if (t.doneCount > 0) t.doneCount -= 1;
        t.lastDoneAt = rec.prevLastDoneAt ?? null;
        if (t.type === 'once' && t.status === 'done') t.status = 'available';
      }
      markHistoryUndone(state, rec.id);
      pushHistory(state, { type: 'completion_undone', title: rec.title, coins: rec.coins, ref: rec.id }, now);
      return { coins: rec.coins };
    }

    case 'saveTask': {
      const input = p.task || {};
      if (input.id) {
        const t = find(state.tasks, input.id, 'Esa tarea ya no existe.');
        Object.assign(t, cleanTask(input, t));
        if (t.type === 'recurring' && t.status === 'done') t.status = 'available';
      } else {
        state.tasks.push(
          cleanTask(input, { id: crypto.randomUUID(), archived: false, status: 'available', doneCount: 0, lastDoneAt: null })
        );
      }
      return {};
    }

    case 'archiveTask': {
      find(state.tasks, p.taskId, 'Esa tarea ya no existe.').archived = !!p.archived;
      return {};
    }

    case 'reopenTask': {
      const t = find(state.tasks, p.taskId, 'Esa tarea ya no existe.');
      if (t.status !== 'done') throw new HttpError(409, 'Esa tarea no está completada.');
      t.status = 'available';
      return {};
    }

    case 'deleteTask': {
      const t = find(state.tasks, p.taskId, 'Esa tarea ya no existe.');
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      return {};
    }

    /* ---- Recompensas ---- */
    case 'saveReward': {
      const input = p.reward || {};
      if (input.id) {
        const r = find(state.rewards, input.id, 'Esa recompensa ya no existe.');
        Object.assign(r, cleanReward(input, r));
      } else {
        state.rewards.push(cleanReward(input, { id: crypto.randomUUID(), archived: false, timesRedeemed: 0 }));
      }
      return {};
    }

    case 'archiveReward': {
      find(state.rewards, p.rewardId, 'Esa recompensa ya no existe.').archived = !!p.archived;
      return {};
    }

    case 'deleteReward': {
      const r = find(state.rewards, p.rewardId, 'Esa recompensa ya no existe.');
      state.rewards = state.rewards.filter((x) => x.id !== r.id);
      return {};
    }

    case 'redeemReward': {
      const r = find(state.rewards, p.rewardId, 'Esa recompensa ya no existe.');
      if (r.archived) throw new HttpError(409, 'Esa recompensa está archivada.');
      if (state.coins < r.cost) throw new HttpError(409, `Todavía te faltan ${r.cost - state.coins} monedas para esta recompensa.`);
      state.coins -= r.cost;
      state.totals.spent += r.cost;
      r.timesRedeemed += 1;
      const h = pushHistory(state, { type: 'redeemed', title: r.title, icon: r.icon, coins: r.cost }, now);
      pushLog(state.redemptions, { id: h.id, at: now, rewardId: r.id, title: r.title, icon: r.icon, coins: r.cost, undone: false });
      return { reward: { id: r.id, title: r.title, icon: r.icon, cost: r.cost }, redemptionId: h.id };
    }

    case 'undoRedeem': {
      const rec = find(state.redemptions, p.redemptionId, 'Ese canje ya no está en el registro.');
      if (rec.undone) throw new HttpError(409, 'Ese canje ya estaba deshecho.');
      rec.undone = true;
      rec.undoneAt = now;
      state.coins += rec.coins;
      state.totals.spent = Math.max(0, state.totals.spent - rec.coins);
      const r = state.rewards.find((x) => x.id === rec.rewardId);
      if (r && r.timesRedeemed > 0) r.timesRedeemed -= 1;
      markHistoryUndone(state, rec.id);
      pushHistory(state, { type: 'redeem_undone', title: rec.title, icon: rec.icon, coins: rec.coins, ref: rec.id }, now);
      return { coins: rec.coins };
    }

    /* ---- Penalizaciones (manuales, restan del bote, sin bajar de 0) ---- */
    case 'savePenaltyType': {
      const input = p.type || {};
      if (input.id) {
        const pt = find(state.penaltyTypes, input.id, 'Esa penalización ya no está en la lista.');
        Object.assign(pt, cleanPenaltyType(input, pt));
      } else {
        if (state.penaltyTypes.length >= MAX_PENALTY_TYPES) throw new HttpError(409, `La lista ya tiene ${MAX_PENALTY_TYPES} penalizaciones.`);
        state.penaltyTypes.push(cleanPenaltyType(input, { id: crypto.randomUUID() }));
      }
      return {};
    }

    case 'deletePenaltyType': {
      const pt = find(state.penaltyTypes, p.typeId, 'Esa penalización ya no está en la lista.');
      state.penaltyTypes = state.penaltyTypes.filter((x) => x.id !== pt.id);
      return {};
    }

    case 'applyPenalty': {
      const pt = find(state.penaltyTypes, p.typeId, 'Esa penalización ya no está en la lista.');
      const amount = BASE[pt.difficulty];
      const applied = Math.min(state.coins, amount);
      state.coins -= applied;
      state.totals.penalized += applied;
      const h = pushHistory(state, { type: 'penalized', title: pt.title, coins: amount, applied }, now);
      pushLog(state.penalties, {
        id: h.id, at: now, typeId: pt.id, title: pt.title, difficulty: pt.difficulty, amount, applied, undone: false,
      });
      return { applied, amount, penaltyId: h.id };
    }

    case 'undoPenalty': {
      const rec = find(state.penalties, p.penaltyId, 'Esa penalización ya no está en el registro.');
      if (rec.undone) throw new HttpError(409, 'Esa penalización ya estaba deshecha.');
      rec.undone = true;
      rec.undoneAt = now;
      state.coins += rec.applied;
      state.totals.penalized = Math.max(0, state.totals.penalized - rec.applied);
      markHistoryUndone(state, rec.id);
      pushHistory(state, { type: 'penalty_undone', title: rec.title, coins: rec.applied, ref: rec.id }, now);
      return { applied: rec.applied };
    }

    default:
      throw new HttpError(400, 'Acción desconocida.');
  }
}

/* ------------------------------------------------------------------ */
/* Almacenamiento (KV)                                                 */
/* ------------------------------------------------------------------ */

async function loadState(env) {
  const stored = await env.BOTE_KV.get(STATE_KEY, 'json');
  if (stored) return stored;
  const fresh = makeInitialState(new Date().toISOString());
  await env.BOTE_KV.put(STATE_KEY, JSON.stringify(fresh));
  return fresh;
}

async function saveState(env, state) {
  const body = JSON.stringify(state);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await env.BOTE_KV.put(STATE_KEY, body);
      return;
    } catch (err) {
      // KV limita las escrituras a 1 por segundo en la misma clave
      if (attempt === 1) throw new HttpError(503, 'No se pudo guardar. Inténtalo de nuevo en unos segundos.');
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      ...corsHeaders(env),
    },
  });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      if (!env.BOTE_KV) throw new HttpError(500, 'Falta el binding de KV (BOTE_KV).');

      if (env.APP_CODE) {
        const code = request.headers.get('X-App-Code') || '';
        if (!safeEqual(code, String(env.APP_CODE))) throw new HttpError(401, 'Código incorrecto.');
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        return json(env, { state: await loadState(env) });
      }

      if (url.pathname === '/api/action' && request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          throw new HttpError(400, 'Petición no válida.');
        }
        const state = await loadState(env);
        const now = new Date().toISOString();
        const today = todayIn(env.TZ_NAME || 'Europe/Madrid');
        const result = applyAction(state, String((body && body.action) || ''), body && body.payload, now, today);
        state.version += 1;
        state.updatedAt = now;
        await saveState(env, state);
        return json(env, { state, result });
      }

      throw new HttpError(404, 'No encontrado.');
    } catch (err) {
      if (err instanceof HttpError) return json(env, { error: err.message }, err.status);
      console.error(err);
      return json(env, { error: 'Error interno del servidor.' }, 500);
    }
  },
};
