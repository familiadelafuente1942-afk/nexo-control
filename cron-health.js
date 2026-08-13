// Corre solo cada 10 minutos (ver vercel.json) — no depende de que nadie
// tenga NEXO Control abierto. Chequea Vercel/Claude/Resend (vía hyper-worker,
// que ya tiene las claves privadas del lado del servidor) y Supabase directo,
// y guarda un registro en system_health para poder calcular uptime real.

const SUPA_URL = "https://bxhjgxzvayszfqwlwinq.supabase.co";
const SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4aGpneHp2YXlzemZxd2x3aW5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NTI4NTMsImV4cCI6MjA5ODQyODg1M30.Wq7TbIUc0t3u7vbmi_yU49BlOaWzl9sByySBpV1HcZQ";
const HEALTH_URL = SUPA_URL + "/functions/v1/hyper-worker";

async function medirSupabase() {
  const inicio = Date.now();
  try {
    const r = await fetch(SUPA_URL + "/rest/v1/bco_storage?select=key&limit=1", {
      headers: { apikey: SUPA_ANON, Authorization: "Bearer " + SUPA_ANON },
    });
    return { ok: r.ok, ms: Date.now() - inicio };
  } catch (e) {
    return { ok: false, ms: Date.now() - inicio };
  }
}

const SH = () => ({ "Content-Type": "application/json", apikey: SUPA_ANON, Authorization: "Bearer " + SUPA_ANON });

// Abre (o actualiza) una alerta identificada por "clave". Si ya existe abierta, no duplica.
async function abrirAlerta(clave, nivel, titulo, detalle) {
  await fetch(SUPA_URL + "/rest/v1/alertas?on_conflict=clave", {
    method: "POST",
    headers: { ...SH(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ clave, nivel, titulo, detalle, estado: "open", actualizado_en: new Date().toISOString(), resuelta_en: null }),
  }).catch(() => {});
}

// Cierra una alerta si existe y sigue abierta (la condición que la disparó ya no se cumple)
async function resolverAlerta(clave) {
  await fetch(SUPA_URL + "/rest/v1/alertas?clave=eq." + encodeURIComponent(clave) + "&estado=eq.open", {
    method: "PATCH",
    headers: { ...SH(), Prefer: "return=minimal" },
    body: JSON.stringify({ estado: "resolved", resuelta_en: new Date().toISOString() }),
  }).catch(() => {});
}

// Regla 1: un servicio caído en los últimos 2 chequeos seguidos (20 minutos)
async function chequearServiciosCaidos() {
  const r = await fetch(SUPA_URL + "/rest/v1/system_health?select=vercel_ok,claude_ok,resend_ok,supabase_ok&order=creado_en.desc&limit=2", { headers: SH() });
  const filas = await r.json().catch(() => []);
  if (!Array.isArray(filas) || filas.length < 2) return;
  const servicios = ["vercel", "claude", "resend", "supabase"];
  for (const s of servicios) {
    const caidoSiempre = filas.every(f => f[s + "_ok"] === false);
    if (caidoSiempre) {
      await abrirAlerta("caido:" + s, "critical", s.charAt(0).toUpperCase() + s.slice(1) + " no responde", "Los últimos 2 chequeos automáticos (20 min) fallaron para " + s + ".");
    } else {
      await resolverAlerta("caido:" + s);
    }
  }
}

// Regla 2: gasto de Claude hoy muy por encima del promedio diario del mes
async function chequearGastoClaudeAnomalo() {
  const ahora = new Date();
  const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1)).toISOString();
  const inicioHoy = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate())).toISOString();
  const r = await fetch(SUPA_URL + "/rest/v1/ai_usage?creado_en=gte." + encodeURIComponent(inicioMes) + "&select=costo_usd,creado_en&limit=10000", { headers: SH() });
  const filas = await r.json().catch(() => []);
  if (!Array.isArray(filas) || filas.length === 0) return;
  let mes = 0, hoy = 0;
  filas.forEach(f => { const c = Number(f.costo_usd) || 0; mes += c; if (f.creado_en >= inicioHoy) hoy += c; });
  const diasTranscurridos = Math.max(1, ahora.getUTCDate());
  const promedioDiario = mes / diasTranscurridos;
  if (promedioDiario > 0.01 && hoy > promedioDiario * 1.4) {
    await abrirAlerta("gasto-claude-alto", "warning", "Gasto de Claude por encima de lo normal", "Hoy se gastó $" + hoy.toFixed(2) + " — el promedio diario del mes es $" + promedioDiario.toFixed(2) + ".");
  } else {
    await resolverAlerta("gasto-claude-alto");
  }
}

// Regla 3: un incidente (error repetido) con muchas ocurrencias
async function chequearIncidentesGraves() {
  const r = await fetch(SUPA_URL + "/rest/v1/incidentes?estado=eq.open&ocurrencias=gte.5&select=id,app,mensaje,ocurrencias", { headers: SH() });
  const filas = await r.json().catch(() => []);
  (filas || []).forEach(inc => {
    abrirAlerta("incidente-grave:" + inc.id, "critical", "Error repetido en " + inc.app, (inc.mensaje || "").slice(0, 140) + " — " + inc.ocurrencias + " veces.");
  });
}

export default async function handler(req, res) {
  try {
    const [salud, supa] = await Promise.all([
      fetch(HEALTH_URL, { headers: { apikey: SUPA_ANON, Authorization: "Bearer " + SUPA_ANON } }).then(r => r.json()).catch(() => ({})),
      medirSupabase(),
    ]);

    const fila = {
      vercel_ok: !!(salud.vercel && salud.vercel.ok),
      vercel_ms: salud.vercel ? salud.vercel.latenciaMs : null,
      claude_ok: !!(salud.claude && salud.claude.ok),
      claude_ms: salud.claude ? salud.claude.latenciaMs : null,
      resend_ok: !!(salud.resend && salud.resend.ok),
      resend_ms: salud.resend ? salud.resend.latenciaMs : null,
      supabase_ok: supa.ok,
      supabase_ms: supa.ms,
    };

    await fetch(SUPA_URL + "/rest/v1/system_health", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPA_ANON,
        Authorization: "Bearer " + SUPA_ANON,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fila),
    });

    // Evaluar las reglas de alertas — cada una abre/cierra sola según corresponda.
    // Si una regla falla, no frena a las demás (por eso van con su propio catch adentro).
    await Promise.allSettled([
      chequearServiciosCaidos(),
      chequearGastoClaudeAnomalo(),
      chequearIncidentesGraves(),
    ]);

    res.status(200).json({ ok: true, fila });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
