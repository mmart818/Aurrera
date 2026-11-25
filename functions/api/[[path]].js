// Solo para quien despliega en Cloudflare PAGES (no con `wrangler deploy`).
// Convierte /api/* en una Pages Function que reutiliza la lógica de worker.js.
// Binding necesario en el panel de Pages: Settings > Bindings > KV namespace, variable: GZN_KV
import worker from '../../worker.js';

export const onRequest = (context) => worker.fetch(context.request, context.env);
