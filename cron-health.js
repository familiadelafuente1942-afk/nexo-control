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

export default async function handler(req, res) {
  // Protección básica: solo deja pasar al cron real de Vercel (o si probás a mano con el secreto)
  const esVercelCron = (req.headers["user-agent"] || "").includes("vercel-cron");
  const secretoOk = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!esVercelCron && !secretoOk) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

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

    res.status(200).json({ ok: true, fila });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
