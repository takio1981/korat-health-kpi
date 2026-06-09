/**
 * Cloudflare Worker — LINE Webhook Handler for KHUPS KPI
 *
 * Architecture (เนื่องจาก production block Cloudflare IPs):
 *   1. LINE → Worker (verify signature)
 *   2. Worker → reply ตรงๆ ไป LINE Reply API (ไม่พึ่ง production)
 *   3. Worker → async forward → KHUPS production (best-effort, fail ไม่เป็นไร)
 *      KHUPS เก็บ inbox tracking ถ้า reach ได้
 *
 * Required env vars (Settings → Variables and Secrets):
 *   LINE_CHANNEL_SECRET = e9a2a72a72ee2bd5b3d3c36ab905ba05  (จาก LINE Console)
 *   LINE_CHANNEL_TOKEN  = (Channel Access Token from LINE Console — สำหรับ Worker เรียก Reply API)
 *   KHUPS_RELAY_URL     = https://apikorat.moph.go.th/khupskpi/api/webhook/line
 *   RELAY_AUTH_KEY      = (จาก KHUPS Settings — สำหรับ inbox tracking)
 *   APP_URL             = https://apikorat.moph.go.th/khupskpi  (สำหรับลิงก์ใน reply message)
 */

const REPLY_API = 'https://api.line.me/v2/bot/message/reply';

async function callReplyApi(replyToken, messages, channelToken) {
  const res = await fetch(REPLY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${channelToken}`
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) })
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

function buildMessages(evType, userId, messageText, appUrl) {
  const lowerText = (messageText || '').toLowerCase().trim();
  const isQuestionForId = /(\buserid\b|\buser id\b|\buser_id\b|\bid\b|ไอดี|รหัส|เริ่ม|\bstart\b|\/start|\bhelp\b|\?)/i.test(lowerText);

  if (evType === 'follow') {
    return [
      { type: 'text', text: `🙏 ยินดีต้อนรับสู่ระบบ KHUPS KPI\n\n📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
      { type: 'text', text: userId },
      { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin หรือ Login ${appUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว"\n3️⃣ พิมพ์ "id" ที่นี่ → ขอ userId ใหม่ได้ทุกเมื่อ` }
    ];
  }
  if (evType === 'message' && isQuestionForId) {
    return [
      { type: 'text', text: `📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
      { type: 'text', text: userId },
      { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin\n3️⃣ Login ${appUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว" → วาง userId → บันทึก\n\nจะได้รับแจ้งเตือน: login, อนุมัติบัญชี, reset password, มีคนตอบกระทู้` }
    ];
  }
  // ข้อความอื่น — ตอบสั้นๆ
  return [{ type: 'text', text: `สวัสดีครับ 👋\nระบบจะส่งแจ้งเตือนเข้า LINE นี้\n\nพิมพ์ "id" → ดู userId ของคุณ\nพิมพ์ "help" → ดูวิธีใช้` }];
}

export default {
  async fetch(request, env, ctx) {
    const ts = new Date().toISOString();

    // === GET = health check ===
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'KHUPS LINE Webhook Handler',
          time: ts,
          has_channel_secret: !!env.LINE_CHANNEL_SECRET,
          has_channel_token: !!env.LINE_CHANNEL_TOKEN,
          has_relay_url: !!env.KHUPS_RELAY_URL,
          has_relay_auth_key: !!env.RELAY_AUTH_KEY,
          has_app_url: !!env.APP_URL,
          mode: 'reply directly + best-effort forward'
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // === POST handling ===
    const body = await request.text();
    const signature = request.headers.get('x-line-signature') || '';
    console.log(`[${ts}] POST received — body=${body.length}B sig=${signature ? signature.slice(0, 16) + '...' : '(missing)'}`);

    // === Verify LINE signature (require channel secret) ===
    let signatureOK = false;
    if (env.LINE_CHANNEL_SECRET && signature) {
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
        signatureOK = (signature === expectedSig);
        if (signatureOK) {
          console.log(`[${ts}] ✓ LINE signature verified`);
        } else {
          console.warn(`[${ts}] ✗ Signature mismatch`);
        }
      } catch (e) {
        console.error(`[${ts}] Signature verify error:`, e.message);
      }
    } else {
      console.warn(`[${ts}] Skipping signature verify (no secret or no header)`);
    }

    // === Parse events ===
    let parsedBody = {};
    try { parsedBody = JSON.parse(body); } catch (e) { console.error('JSON parse error:', e.message); }
    const events = parsedBody.events || [];
    console.log(`[${ts}] Events count: ${events.length}`);

    // === Best-effort forward to KHUPS (async — fail ไม่กระทบ user) ===
    if (env.KHUPS_RELAY_URL && events.length > 0) {
      ctx.waitUntil(
        fetch(env.KHUPS_RELAY_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Relay-Auth': env.RELAY_AUTH_KEY || '',
            'X-Line-Signature': signature,
            'X-Forwarded-From': 'cloudflare-worker'
          },
          body,
          // Cloudflare Workers signal timeout — กัน hang 30s
          signal: AbortSignal.timeout(5000)
        })
          .then(r => console.log(`[${ts}] → KHUPS forward: ${r.status}`))
          .catch(e => console.warn(`[${ts}] → KHUPS forward failed (ignored):`, e.message))
      );
    }

    // === Reply to LINE directly (สำคัญที่สุด — ทำงานแน่นอน) ===
    const appUrl = (env.APP_URL || 'https://apikorat.moph.go.th/khupskpi').replace(/\/+$/, '');
    if (env.LINE_CHANNEL_TOKEN) {
      for (const ev of events) {
        const lineUserId = ev?.source?.userId;
        const replyToken = ev?.replyToken;
        const evType = ev?.type;
        if (!lineUserId || !replyToken) {
          console.log(`[${ts}] skip event: type=${evType} hasUserId=${!!lineUserId} hasReplyToken=${!!replyToken}`);
          continue;
        }
        if (evType !== 'follow' && evType !== 'message') {
          console.log(`[${ts}] skip event type=${evType}`);
          continue;
        }

        const messageText = ev?.message?.text || '';
        const messages = buildMessages(evType, lineUserId, messageText, appUrl);

        try {
          const result = await callReplyApi(replyToken, messages, env.LINE_CHANNEL_TOKEN);
          if (result.ok) {
            console.log(`[${ts}] ✓ reply SUCCESS to ${lineUserId.slice(0, 12)}... msgs=${messages.length}`);
          } else {
            console.error(`[${ts}] ✗ reply FAILED status=${result.status} body=${result.body.slice(0, 300)}`);
          }
        } catch (e) {
          console.error(`[${ts}] reply error:`, e.message);
        }
      }
    } else {
      console.warn(`[${ts}] LINE_CHANNEL_TOKEN not set — cannot reply`);
    }

    // === Always return 200 OK ===
    return new Response('OK', { status: 200 });
  }
};
