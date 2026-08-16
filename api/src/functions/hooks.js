// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — global error logging
// Azure Functions v4 postInvocation hook: fires after EVERY function
// invocation across the whole API. If the handler threw (a real bug,
// not a normal err()/400 response), write it to app_logs so it shows
// up in Admin → Settings → Application Logs without anyone needing to
// go spelunking in Azure's own log stream.
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');

app.hook.postInvocation(async (context) => {
  if (!context.error) return;
  try {
    const e = context.error;
    const fnName = context.invocationContext?.functionName || context.functionName || 'unknown';
    await query(
      `INSERT INTO public.app_logs (level, event, detail) VALUES ('error', 'api.unhandled_exception', $1)`,
      [`[${fnName}] ${String(e?.stack || e?.message || e)}`.slice(0, 4000)]
    );
  } catch {
    // Logging must never itself crash the runtime.
  }
});

module.exports = {};
