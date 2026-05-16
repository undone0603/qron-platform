import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * QRON Browser Agent
 * Playwright + Claude vision loop for autonomous web research tasks.
 * Runs via GitHub Actions (agentZ-browser.yml). Never runs in Vercel.
 *
 * Tasks:
 *  - monitor_strainchain: scrape strainchain.io for new batch submissions / cert events
 *  - monitor_govchain:    scrape govchain.us for new proposals and DAO activity
 *  - research_grants:     discover new grant opportunities on sam.gov / grants.gov
 */

// Playwright is installed by the GitHub Actions workflow via:
//   npx playwright install chromium --with-deps
// This avoids adding it to package.json devDependencies.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium } = require('playwright');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;
const DRY_RUN = process.env.DRY_RUN === 'true';

const TASK = (process.env.BROWSER_TASK ?? 'monitor_strainchain') as
  | 'monitor_strainchain'
  | 'monitor_govchain'
  | 'research_grants';

// ─── Claude helpers ──────────────────────────────────────────────────────────

async function analyzeScreenshot(
  screenshotBase64: string,
  instruction: string,
): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
            },
            { type: 'text', text: instruction },
          ],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find((c) => c.type === 'text')?.text ?? '';
}

async function askClaude(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find((c) => c.type === 'text')?.text ?? '';
}

// ─── Task: Monitor StrainChain ────────────────────────────────────────────────

async function monitorStrainChain() {
  console.log('🔬 TASK: Monitor StrainChain — strainchain.io');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://strainchain.io', { waitUntil: 'networkidle', timeout: 30_000 });
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const b64 = Buffer.from(screenshot).toString('base64');

    const analysis = await analyzeScreenshot(
      b64,
      `You are monitoring strainchain.io for the AuthiChain protocol team.
      Analyze this screenshot and extract:
      1. Any new batch submissions or certification events visible
      2. Platform status (online/degraded/offline)
      3. Any alerts, warnings, or notable announcements
      4. Recent activity counts if visible

      Respond in JSON: { "status": string, "new_events": string[], "alerts": string[], "summary": string }`,
    );

    let parsed: { status: string; new_events: string[]; alerts: string[]; summary: string };
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { status: 'unknown', new_events: [], alerts: [], summary: analysis };
    } catch {
      parsed = { status: 'unknown', new_events: [], alerts: [], summary: analysis };
    }

    console.log(`   Status: ${parsed.status}`);
    console.log(`   New events: ${parsed.new_events.length}`);
    console.log(`   Alerts: ${parsed.alerts.length}`);
    console.log(`   Summary: ${parsed.summary.slice(0, 200)}`);

    if (!DRY_RUN && admin) {
      await admin.from('automation_logs').insert({
        workflow_name: 'browser_agent_strainchain',
        trigger: 'cron',
        status: 'success',
        metadata: parsed,
        created_at: new Date().toISOString(),
      });

      // Surface any alerts as protocol anomalies
      for (const alert of parsed.alerts) {
        await admin.from('protocol_anomalies').insert({
          type: 'strainchain_monitor',
          severity: 'medium',
          description: alert,
          metadata: { source: 'browser_agent', task: 'monitor_strainchain' },
        });
      }
    }
  } finally {
    await browser.close();
  }
}

// ─── Task: Monitor GovChain ──────────────────────────────────────────────────

async function monitorGovChain() {
  console.log('⚖️  TASK: Monitor GovChain — govchain.us');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://govchain.us', { waitUntil: 'networkidle', timeout: 30_000 });
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const b64 = Buffer.from(screenshot).toString('base64');

    const analysis = await analyzeScreenshot(
      b64,
      `You are monitoring govchain.us for the AuthiChain DAO governance team.
      Analyze this screenshot and extract:
      1. Active governance proposals (title, voting status, deadline)
      2. Recent DAO activity (new proposals, votes cast, proposals enacted)
      3. Platform status
      4. Any urgent votes closing within 48 hours

      Respond in JSON: { "active_proposals": [{title: string, deadline: string, status: string}], "urgent": string[], "summary": string }`,
    );

    let parsed: { active_proposals: Array<{ title: string; deadline: string; status: string }>; urgent: string[]; summary: string };
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { active_proposals: [], urgent: [], summary: analysis };
    } catch {
      parsed = { active_proposals: [], urgent: [], summary: analysis };
    }

    console.log(`   Active proposals: ${parsed.active_proposals.length}`);
    console.log(`   Urgent (48h): ${parsed.urgent.length}`);
    console.log(`   Summary: ${parsed.summary.slice(0, 200)}`);

    if (!DRY_RUN && admin) {
      await admin.from('automation_logs').insert({
        workflow_name: 'browser_agent_govchain',
        trigger: 'cron',
        status: 'success',
        metadata: parsed,
        created_at: new Date().toISOString(),
      });

      // Push urgent vote reminders to DAO webhook
      if (parsed.urgent.length > 0) {
        const webhook = process.env.DAO_COMMUNITY_WEBHOOK_URL;
        if (webhook) {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `⏰ **GovChain — Urgent Votes Closing Soon**\n${parsed.urgent.map((u) => `• ${u}`).join('\n')}\n\nVote now at govchain.us`,
            }),
          });
        }
      }
    }
  } finally {
    await browser.close();
  }
}

// ─── Task: Research Grants ───────────────────────────────────────────────────

async function researchGrants() {
  console.log('🏛️  TASK: Research new grants — sam.gov / grants.gov');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const opportunities: Array<{ title: string; value: string; deadline: string; url: string; relevance: string }> = [];

  try {
    // Search SAM.gov for relevant opportunities
    await page.goto(
      'https://sam.gov/search/?index=opp&q=supply+chain+authentication+blockchain&sort=-modifiedDate&is_active=true',
      { waitUntil: 'networkidle', timeout: 30_000 },
    );

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    const b64 = Buffer.from(screenshot).toString('base64');

    const analysis = await analyzeScreenshot(
      b64,
      `You are identifying federal contracting opportunities for AuthiChain, a supply chain authentication company.
      AuthiChain sells: hardware-free QR authentication, Ed25519 cryptographic provenance, blockchain anchoring, industrial DPP.

      From this SAM.gov search results page, extract any relevant opportunities:
      - Supply chain security
      - Anti-counterfeiting / product authentication
      - Blockchain / DLT for government
      - Industrial provenance tracking

      Respond in JSON: { "opportunities": [{ "title": string, "value": string, "deadline": string, "relevance": string }], "count": number }`,
    );

    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { opportunities: typeof opportunities; count: number };
        opportunities.push(...(parsed.opportunities ?? []));
        console.log(`   SAM.gov: ${parsed.count ?? 0} results, ${opportunities.length} relevant`);
      }
    } catch {
      console.warn('   Could not parse SAM.gov analysis');
    }
  } catch (err) {
    console.warn('   SAM.gov scrape failed:', err instanceof Error ? err.message : err);
  } finally {
    await browser.close();
  }

  // For each opportunity, generate a qualification summary using Claude text
  for (const opp of opportunities.slice(0, 5)) {
    const qualification = await askClaude(
      `AuthiChain is a supply chain authentication company using AI-augmented QR codes (QRONs), Ed25519 cryptography, and blockchain anchoring.

      Should we bid on this federal opportunity? Give a 2-sentence go/no-go recommendation.

      Opportunity: ${opp.title}
      Value: ${opp.value}
      Relevance note: ${opp.relevance}`,
    );

    console.log(`\n   📋 ${opp.title}`);
    console.log(`      Value: ${opp.value} | Deadline: ${opp.deadline}`);
    console.log(`      ${qualification.slice(0, 200)}`);

    if (!DRY_RUN && admin) {
      await admin.from('governance_proposals').upsert({
        id: `grant_research_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: `[Research] ${opp.title}`,
        description: `Value: ${opp.value}\nDeadline: ${opp.deadline}\nRelevance: ${opp.relevance}\n\nClaude recommendation:\n${qualification}`,
        status: 'draft',
        yes_votes: 0,
        no_votes: 0,
        quorum_required: 0,
        pass_threshold: 100,
        end_time: opp.deadline ? new Date(opp.deadline).toISOString() : new Date(Date.now() + 30 * 86_400_000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    }
  }

  console.log(`\n   ✅ Research complete. ${opportunities.length} opportunities surfaced.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🤖 QRON BROWSER AGENT`);
  console.log(`   Task:   ${TASK}`);
  console.log(`   Mode:   ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   LLM:    ${ANTHROPIC_API_KEY ? 'Claude claude-sonnet-4-6 (vision)' : '⚠️  No API key — will fail'}`);
  console.log(`${'='.repeat(60)}\n`);

  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY is required for the browser agent.');
    process.exit(1);
  }

  switch (TASK) {
    case 'monitor_strainchain': await monitorStrainChain(); break;
    case 'monitor_govchain':    await monitorGovChain(); break;
    case 'research_grants':     await researchGrants(); break;
    default:
      console.error(`Unknown task: ${TASK}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Browser agent failed:', err);
  process.exit(1);
});
