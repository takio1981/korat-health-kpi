/**
 * Cloudflare Worker — LINE Webhook Forwarder for KHUPS KPI
 *
 * What it does:
 *   1. รับ LINE webhook events ที่ silent-meadow-aae1.takio1981.workers.dev
 *   2. Verify LINE signature ด้วย LINE_CHANNEL_SECRET (defense in depth)
 *   3. Forward event ไปที่ KHUPS backend (KHUPS_RELAY_URL)
 *      พร้อม header X-Relay-Auth = RELAY_AUTH_KEY
 *   4. KHUPS backend ตอบกลับ user (userId, คู่มือ ฯลฯ) ผ่าน LINE Reply API
 *
 * Deploy:
 *   1. ไปที่ https://dash.cloudflare.com → Workers & Pages → silent-meadow-aae1
 *   2. Edit Code → วาง code นี้ทั้งหมด
 *   3. Settings → Variables → เพิ่ม 3 environment variables:
 *        LINE_CHANNEL_SECRET    = e9a2a72a72ee2bd5b3d3c36ab905ba05   (จาก LINE Console)
 *        KHUPS_RELAY_URL        = https://apikorat.moph.go.th/khupskpi/api/webhook/line
 *        RELAY_AUTH_KEY         = (ค่าจาก KHUPS Settings → "LINE Relay Auth Key")
 *   4. Save and Deploy
 *
 * Verify in LINE Console:
 *   - Webhook URL = https://silent-meadow-aae1.takio1981.workers.dev/
 *   - กด Verify → ต้องขึ้น Success
 *   - Use webhook = Enabled
 */

export default {
  async fetch(request, env, ctx) {
    // === GET = health check (เปิดผ่าน browser ตรวจสถานะได้) ===
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'KHUPS LINE Webhook Relay',
          khups_relay_url: env.KHUPS_RELAY_URL || '(not set)',
          has_channel_secret: !!env.LINE_CHANNEL_SECRET,
          has_relay_auth_key: !!env.RELAY_AUTH_KEY
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // === Read raw body (สำคัญสำหรับ signature verification) ===
    const body = await request.text();
    const signature = request.headers.get('x-line-signature') || '';

    // === Verify LINE signature (ถ้าตั้ง env LINE_CHANNEL_SECRET ไว้) ===
    if (env.LINE_CHANNEL_SECRET) {
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
        // Convert ArrayBuffer → base64
        const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
        if (signature !== expectedSig) {
          console.warn('[Worker] signature mismatch', { got: signature.slice(0, 12), expected: expectedSig.slice(0, 12) });
          return new Response('Invalid signature', { status: 401 });
        }
        console.log('[Worker] LINE signature verified');
      } catch (e) {
        console.error('[Worker] signature verify error:', e.message);
        return new Response('Signature verification error', { status: 500 });
      }
    } else {
      console.warn('[Worker] LINE_CHANNEL_SECRET not set — skip verification');
    }

    // === Forward to KHUPS backend (asynchronously) ===
    if (env.KHUPS_RELAY_URL) {
      ctx.waitUntil(
        fetch(env.KHUPS_RELAY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Auth': env.RELAY_AUTH_KEY || '',
            'X-Line-Signature': signature, // optional — backend อาจ verify ซ้ำ
            'X-Forwarded-From': 'cloudflare-worker'
          },
          body
        })
          .then(r => console.log('[Worker] forwarded to KHUPS:', r.status))
          .catch(e => console.error('[Worker] forward error:', e.message))
      );
    } else {
      console.warn('[Worker] KHUPS_RELAY_URL not set — event discarded');
    }

    // === Reply 200 OK ทันที (LINE timeout < 2s) ===
    return new Response('OK', { status: 200 });
  }
};
