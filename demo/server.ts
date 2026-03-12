/**
 * Railclaw Demo UI Server
 *
 * Two responsibilities only:
 *   1. Serve the two-panel HTML UI (no business logic)
 *   2. Proxy /api/chat/* → OpenClaw gateway /v1/responses (keeps token server-side)
 *   3. Host /api/service/premium — an x402-protected endpoint for nanopayment testing
 *
 * All payment logic lives in OpenClaw agents (orchestrator, boundary-manager, etc.)
 *
 * Run: tsx server.ts   (started by railclaw-demo.service on EC2)
 * Open: http://<EC2_IP>:3100
 */

import express, { Request, Response } from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DEMO_PORT || '3100');

// OpenClaw gateway — loopback, same EC2 machine
const OPENCLAW_URL = 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

// Circle seller address for x402 endpoint
const SELLER_ADDRESS = process.env.CIRCLE_SELLER_ADDRESS || '';

const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, 'public')));

// ─── Proxy: browser → OpenClaw gateway ───────────────────────────────────────
//
// The browser can't call OpenClaw directly (loopback + token). This proxy
// forwards the message and streams the response back.

async function proxyToAgent(agentId: string, message: string, res: Response) {
  if (!OPENCLAW_TOKEN) {
    res.status(500).json({ error: 'OPENCLAW_GATEWAY_TOKEN not set. Run setup.sh.' });
    return;
  }

  try {
    const upstream = await fetch(`${OPENCLAW_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        'x-openclaw-agent-id': agentId,
      },
      body: JSON.stringify({
        model: 'openclaw',
        input: message,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      res.status(upstream.status).json({ error: err });
      return;
    }

    // Stream SSE back to browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(502).json({ error: `OpenClaw gateway unreachable: ${msg}` });
    }
  }
}

// Business owner agent (left panel)
app.post('/api/chat/owner', async (req: Request, res: Response) => {
  const { message } = req.body as { message: string };
  await proxyToAgent('business-owner', message, res);
});

// Product bot / agent side (right panel)
app.post('/api/chat/product', async (req: Request, res: Response) => {
  const { message } = req.body as { message: string };
  await proxyToAgent('business-product', message, res);
});

// ─── x402-protected service endpoint (nanopayment target) ────────────────────
//
// This is the "service being sold" — the orchestrator's nanopayment.ts pays
// this URL via Circle Gateway. Placing it here keeps it co-located with the
// demo but it has NO payment selection logic; it just receives and verifies.

async function setupX402() {
  if (!SELLER_ADDRESS) {
    // No seller address — mount an open endpoint for dev/sim mode
    app.get('/api/service/premium', (_req: Request, res: Response) => {
      res.json({
        service: 'Premium AI Insights',
        data: { insights: 'Exclusive market intelligence (sim mode)', timestamp: new Date().toISOString() },
        note: 'Set CIRCLE_SELLER_ADDRESS in .env for live x402 payment verification',
      });
    });
    console.log('  /api/service/premium → open (no seller address set)');
    return;
  }

  try {
    const { createGatewayMiddleware } = await import('@circle-fin/x402-batching/server');
    const gateway = createGatewayMiddleware({
      sellerAddress: SELLER_ADDRESS as `0x${string}`,
    });

    app.get(
      '/api/service/premium',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gateway.require('$0.01') as any,
      (req: Request, res: Response) => {
        res.json({
          service: 'Premium AI Insights',
          data: { insights: 'Exclusive market intelligence payload', sentiment: 'bullish', confidence: 0.94, timestamp: new Date().toISOString() },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payer: (req as any).payment?.payer ?? 'unknown',
        });
      }
    );
    console.log(`  /api/service/premium → x402 protected ($0.01 USDC → ${SELLER_ADDRESS})`);
  } catch (err) {
    console.warn('  Circle Gateway unavailable — open endpoint fallback:', (err as Error).message);
    app.get('/api/service/premium', (_req: Request, res: Response) => {
      res.json({ service: 'Premium AI Insights', data: { insights: 'Sim mode', timestamp: new Date().toISOString() } });
    });
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    openclawToken: !!OPENCLAW_TOKEN,
    sellerAddress: SELLER_ADDRESS || null,
    port: PORT,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await setupX402();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Railclaw Demo UI  →  http://0.0.0.0:${PORT}`);
    console.log('  Left panel  : Business owner → sends to business-owner agent');
    console.log('  Right panel : Agent terminal → sends to business-product agent');
    console.log(`\n  OpenClaw gateway token: ${OPENCLAW_TOKEN ? 'set' : 'MISSING — run setup.sh'}`);
  });
}

main().catch(err => {
  console.error('Demo server failed to start:', err);
  process.exit(1);
});
