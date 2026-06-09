/**
 * Cloudflare Worker — LINE Webhook Forwarder for KHUPS KPI (DEBUG MODE)
 *
 * DEBUG MODE features:
 *   - Log ทุก request ที่เข้ามา (method, headers, body length) — เห็นใน Real-time logs
 *   - ไม่ reject เมื่อ signature mismatch (แค่ warn) — กัน LINE Verify error
 *   - Forward ทุก request → backend (ให้ KHUPS verify อีกชั้น)
 *   - Return 200 OK เสมอ → LINE Verify จะผ่าน
 *
 * Deploy:
 *   1. https://dash.cloudflare.com → Workers & Pages → silent-meadow-aae1
 *   2. Edit Code → ลบทั้งหมด → วาง code นี้ → Save and Deploy
 *   3. Settings → Variables → ต้องมี 3 ค่า:
 *        LINE_CHANNEL_SECRET = e9a2a72a72ee2bd5b3d3c36ab905ba05
 *        KHUPS_RELAY_URL     = https://apikorat.moph.go.th/khupskpi/api/webhook/line
 *        RELAY_AUTH_KEY      = (ค่าจาก production: ดูใน KHUPS Settings → "Relay Auth Key")
 *
 * Watch logs:
 *   - dash.cloudflare.com → Worker → tab Logs → "Begin log stream"
 *   - กด Verify ใน LINE Console หรือพิมพ์ข้อความใน bot
 *   - ดู log ที่ปรากฏ
 */

export default {
  async fetch(request, env, ctx) {
    const ts = new Date().toISOString();
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '(no UA)';

    // === GET = health check ===
    if (request.method === 'GET') {
      console.log(`[${ts}] GET ${url.pathname} from UA="${ua}"`);
      return new Response(
        JSON.stringify({
          status: 'ok (DEBUG MODE)',
          service: 'KHUPS LINE Webhook Relay',
          time: ts,
          khups_relay_url: env.KHUPS_RELAY_URL || '(not set)',
          has_channel_secret: !!env.LINE_CHANNEL_SECRET,
          has_relay_auth_key: !!env.RELAY_AUTH_KEY,
          mode: 'DEBUG — accepts all requests, forwards to KHUPS'
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (request.method !== 'POST') {
      console.log(`[${ts}] ${request.method} not allowed`);
      return new Response('Method Not Allowed', { status: 405 });
    }

    // === POST handling ===
    const body = await request.text();
    const signature = request.headers.get('x-line-signature') || '';

    // Log incoming request details
    console.log(`[${ts}] POST received — body=${body.length}B sig=${signature ? signature.slice(0, 16) + '...' : '(missing)'} UA="${ua}" CF-Ray=${request.headers.get('cf-ray') || ''}`);
    console.log(`[${ts}] Body preview: ${body.slice(0, 300)}`);

    // === Signature check (warn only, don't reject) ===
    let signatureStatus = 'no-secret-configured';
    if (env.LINE_CHANNEL_SECRET) {
      if (!signature) {
        signatureStatus = 'missing-header';
        console.warn(`[${ts}] ⚠ No x-line-signature header`);
      } else {
        try {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(env.LINE_CHANNEL_SECRET),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
          );
          const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
          const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
          if (signature === expectedSig) {
            signatureStatus = 'verified';
            console.log(`[${ts}] ✓ LINE signature verified`);
          } else {
            signatureStatus = 'mismatch';
            console.warn(`[${ts}] ✗ Signature mismatch — got=${signature.slice(0, 16)}... expected=${expectedSig.slice(0, 16)}...`);
            // DEBUG: don't reject, just warn
          }
        } catch (e) {
          signatureStatus = 'error:' + e.message;
          console.error(`[${ts}] Signature verify error:`, e.message);
        }
      }
    }

    // === Forward to KHUPS backend (asynchronously) ===
    if (env.KHUPS_RELAY_URL) {
      ctx.waitUntil(
        fetch(env.KHUPS_RELAY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Auth': env.RELAY_AUTH_KEY || '',
            'X-Line-Signature': signature,
            'X-Forwarded-From': 'cloudflare-worker',
            'X-Signature-Status': signatureStatus
          },
          body
        })
          .then(r => console.log(`[${ts}] → KHUPS forward response: ${r.status} ${r.statusText}`))
          .catch(e => console.error(`[${ts}] → KHUPS forward FAILED:`, e.message))
      );
    } else {
      console.warn(`[${ts}] KHUPS_RELAY_URL not set — event discarded`);
    }

    // === Always return 200 OK (LINE Verify pass) ===
    return new Response('OK', { status: 200 });
  }
};
