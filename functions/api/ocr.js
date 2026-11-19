// Unlimited-OCR P1 — sync single-image gateway (Pages Function)
// Route: /functions/api/ocr
//
// Role per deployment plan: thin gateway + security boundary, never compute.
// - CORS locked to the Pages origin (same-origin by default)
// - content-type + size guard
// - MOCK mode returns canned Markdown; flip USE_MOCK=false once the
//   vLLM backend (vllm/vllm-openai:unlimited-ocr) is reachable.
//
// Edge limits that shape this design (BytePlus docs): 30 s wall time,
// 50 ms CPU, 128 MB memory, max 4 fetch() per execution. Keep images small
// in P1; PDFs go to the async P2 path (presign -> TOS -> job queue).

const USE_MOCK = true;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB single image for the sync slice
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const ALLOWED_ORIGINS = []; // e.g. ["https://ocr.example.com"]; empty = same-origin only

// Real backend (P0 output). The API key must be an Edge env var/secret,
// never in the Pages bundle.
const BACKEND_URL = typeof OCR_BACKEND_URL !== "undefined" ? OCR_BACKEND_URL : "";
const BACKEND_KEY = typeof OCR_BACKEND_KEY !== "undefined" ? OCR_BACKEND_KEY : "";
const MODEL = "baidu/Unlimited-OCR";

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = {
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return h;
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method === "GET") {
    return json(request, 200, { ok: true, service: "unlimited-ocr-p1", mode: USE_MOCK ? "mock" : "live" });
  }
  if (request.method !== "POST") {
    return json(request, 405, { error: "method_not_allowed" });
  }

  const ctype = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(ctype)) {
    return json(request, 415, { error: "unsupported_type", allowed: ALLOWED_TYPES });
  }
  const declared = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (declared > MAX_BYTES) {
    return json(request, 413, { error: "too_large", max_bytes: MAX_BYTES });
  }

  const started = Date.now();

  if (USE_MOCK) {
    const name = request.headers.get("X-File-Name") || "upload";
    return json(request, 200, {
      mode: "mock",
      model: MODEL,
      file: name,
      bytes: declared,
      latency_ms: Date.now() - started,
      markdown: mockMarkdown(name, ctype, declared),
    });
  }

  // ---- Live path (enable after P0 GPU spike) ----
  if (!BACKEND_URL || !BACKEND_KEY) {
    return json(request, 500, { error: "backend_not_configured" });
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return json(request, 413, { error: "too_large", max_bytes: MAX_BYTES });
  }
  // NOTE: base64 in JS costs CPU; at the 50 ms CPU cap keep images small,
  // or have the backend fetch from TOS instead (P2 shape).
  const b64 = toBase64(new Uint8Array(buf));
  const upstream = await fetch(BACKEND_URL.replace(/\/$/, "") + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + BACKEND_KEY },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${ctype};base64,${b64}` } },
          { type: "text", text: "document parsing." },
        ],
      }],
    }),
  });
  if (!upstream.ok) {
    return json(request, 502, { error: "backend_error", status: upstream.status });
  }
  const data = await upstream.json();
  return json(request, 200, {
    mode: "live",
    model: MODEL,
    latency_ms: Date.now() - started,
    markdown: data?.choices?.[0]?.message?.content || "",
  });
}

function toBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function mockMarkdown(name, ctype, bytes) {
  return [
    `# Parsed: ${name}`,
    "",
    "> **Mock response** from the Pages Function gateway. No GPU was called.",
    "",
    "## Document metadata",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Content-Type | \`${ctype}\` |`,
    `| Size | ${bytes} bytes |`,
    `| Model (target) | \`${MODEL}\` |`,
    "",
    "## Sample extracted text",
    "",
    "INVOICE #INV-2026-0042",
    "",
    "| Item | Qty | Unit price | Total |",
    "|---|---:|---:|---:|",
    "| CDN traffic (TB) | 12 | 18.00 | 216.00 |",
    "| Edge Function requests (M) | 3 | 0.60 | 1.80 |",
    "",
    "**Grand total:** 217.80",
    "",
    "---",
    "_Next: set `USE_MOCK = false` and configure `OCR_BACKEND_URL` / `OCR_BACKEND_KEY` once the vLLM backend is up._",
  ].join("\n");
}
