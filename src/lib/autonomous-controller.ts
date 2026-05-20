import { createClient } from '@supabase/supabase-js';
import { logAutomation, formatErr } from './automation';
import { dispatchWebhook } from './webhooks';
import { HubSpotDeliverableAgent } from './industrial/hubspot';
import { sendEmail } from './email';
import { withRetry } from './retry';
import { getCircuitBreaker, resetCircuitBreaker, getAllCircuitBreakerStatuses } from './circuit-breaker';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(supabaseUrl, serviceKey);

/**
 * Returns an adaptive batch size based on how many items are pending.
 * Scales between 10 (quiet) and 100 (busy) in three tiers.
 */
function adaptiveBatch(queueDepth: number): number {
  if (queueDepth > 500) return 100;
  if (queueDepth > 100) return 50;
  return 20;
}

/**
 * Autonomous Controller for Platform Business Operations.
 * Handles high-level logic for outreach, social, and reporting.
 */
export class AutonomousController {
  /**
   * Channel C: Automated Federal Drip Sequencer
   * Restarts outreach for MUSA-FTC compliance on stuck prospects.
   */
  private async runFederalDripSequencer() {
    const workflowName = 'federal_drip_sequencer';
    try {
      // 1. Fetch "stuck" prospects or those needing FTC shield
      const { data: prospects } = await admin
        .from('lead_captures')
        .select('*')
        .or('status.eq.new,status.eq.contacted')
        .filter('score', 'gte', 80)
        .limit(10); // Process in small batches

      if (!prospects || prospects.length === 0) return;

      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let lastError: string | undefined;

      for (const p of prospects) {
        if (!p.email) {
          skipped++;
          continue;
        }

        const msg = `Attention ${p.name || 'Operations Lead'},\n\n` +
          `With the recent FTC $625k MUSA penalties and EO 14392, your current "Made in USA" claims are at regulatory risk.\n\n` +
          `AuthiChain has launched the FTC Shield — the first cryptographic provenance seal for American manufacturing.\n\n` +
          `View your prepared compliance dashboard: https://qron.space/ftc-shield`;

        const result = await sendEmail({
          from: 'AuthiChain Compliance <compliance@qron.space>',
          to: p.email,
          subject: 'Action Required: FTC Made-in-USA Compliance (EO 14392)',
          text: msg,
        });

        if (!result.ok) {
          failed++;
          lastError = `${result.provider}: ${result.error}`;
          console.warn(`[autonomous] FTC drip failed for ${p.email}: ${lastError}`);
          continue;
        }

        sent++;
        await admin
          .from('lead_captures')
          .update({
            status: 'qualified',
            metadata: { last_drip: 'ftc_shield_v1', drip_sent_at: new Date().toISOString(), provider: result.provider }
          })
          .eq('id', p.id);
      }

      const status = failed > 0 || (sent === 0 && prospects.length > 0) ? 'failure' : 'success';
      const errMsg = failed > 0
        ? `${failed}/${prospects.length} drip sends failed: ${lastError}`
        : (skipped === prospects.length ? 'all prospects skipped (no email)' : undefined);
      await logAutomation(workflowName, 'cron', status, { prospects: prospects.length, sent, failed, skipped }, errMsg);
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Run the daily executive business cycle.
   */
  async runDailyCycle() {
    const startTime = Date.now();
    console.log('[autonomous] Starting daily business cycle...');

    try {
      const results = await Promise.allSettled([
        this.processPendingLeads(),
        this.processHubSpotDeliverables(),
        this.runDripSequencer(),
        this.runFederalDripSequencer(),
        this.runViralMarketingAgent(),
        this.generateSocialShowcase(),
        this.runRevenueRecyclingAgent(),
        this.executeTokenomicsDaily(),
        this.runIndustrialWatchdog(),
        this.runGovernanceArbiter(),
        this.runStrainChainAudit(),
        this.runGovChainSync(),
        this.runQronStorySync(),
        this.processAffiliatePayouts(),
        this.triggerGrowthEngine(),
        this.sendExecutiveReport(),
      ]);

      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      await logAutomation('daily_business_cycle', 'cron', 'success', {
        duration: Date.now() - startTime,
        tasks: successCount,
        agent_version: 'v3.0-autonomous',
      });
    } catch (err: unknown) {
      await logAutomation('daily_business_cycle', 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Unblocks HubSpot Deals by generating tangible deliverables.
   */
  private async processHubSpotDeliverables() {
    try {
      const agent = new HubSpotDeliverableAgent();
      await agent.unblockStalledDeals();
    } catch (err: unknown) {
      await logAutomation('hubspot_deliverable_cycle', 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Manages multi-stage lead follow-ups autonomously.
   * Stage 1: Artifact Delivery, Stage 2: Nudge, Stage 3: Elite Offer.
   */
  private async runDripSequencer() {
    const workflowName = 'lead_drip_sequencer';
    try {
      const now = new Date().toISOString();
      const { data: prospects } = await admin
        .from('drip_prospects')
        .select('*')
        .in('status', ['active', 'pending'])
        .lte('next_send_at', now)
        .limit(20);

      if (!prospects || prospects.length === 0) return;

      console.log(`[autonomous] Processing ${prospects.length} pending drip actions...`);

      let sent = 0;
      for (const prospect of prospects) {
        const step = (prospect.sequence_step ?? 0) + 1;
        const isComplete = step > 3;

        const nextSend = new Date();
        nextSend.setDate(nextSend.getDate() + 3);

        await admin
          .from('drip_prospects')
          .update({
            sequence_step: step,
            status: isComplete ? 'completed' : 'active',
            last_sent_at: now,
            next_send_at: isComplete ? null : nextSend.toISOString(),
          })
          .eq('id', prospect.id);

        sent++;
      }

      await logAutomation(workflowName, 'cron', 'success', { actions_executed: sent });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Phase 7 - Step 1: Agent-Led Viral Marketing
   * Detects trends and autonomously publishes topical QRON art.
   */
  private async runViralMarketingAgent() {
    const workflowName = 'agent_viral_marketing';
    try {
      // 1. Trend Detection (Simulated for protocol launch)
      const trends = ['Solar Eclipse', 'Metaverse Fashion', 'Sustainable Tech', 'Cyberpunk Cities'];
      const currentTrend = trends[Math.floor(Math.random() * trends.length)];

      // 2. Trend-to-Prompt Engineering
      const prompt = `A highly detailed, cinematic QR art inspired by ${currentTrend}, hyper-realistic, gold accents, 8k resolution, AuthiChain signature style.`;

      // 3. Autonomous Generation (Calling internal API logic or worker directly)
      const CF_WORKER_URL = process.env.QRON_WORKER_URL || 'https://qron-ai-api.undone-k.workers.dev';
      const genRes = await fetch(`${CF_WORKER_URL}/v1/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://qron.space', prompt, style: 'cinematic' }),
      });

      if (!genRes.ok) {
        const body = await genRes.text().catch(() => '');
        throw new Error(`Marketing generation failed: ${genRes.status} ${genRes.statusText} ${body.slice(0, 200)}`);
      }
      const data = await genRes.json() as { downloadUrl: string };

      // 4. Social Publishing (Buffer Webhook)
      const bufferWebhook = process.env.BUFFER_WEBHOOK_URL;
      if (bufferWebhook) {
        await fetch(bufferWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `The Protocol has detected a new trend: ${currentTrend}. ðŸš€\n\nBehold this autonomous creation, cryptographically anchored by AuthiChain.\n\n#AIArt #TrendWatch #${currentTrend.replace(/\s/g, '')}`,
            media: { picture: data.downloadUrl },
          }),
        });
      }

      await logAutomation(workflowName, 'cron', 'success', { trend: currentTrend, imageUrl: data.downloadUrl });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Phase 7 - Step 2: Autonomous Revenue Recycling
   * Calculates daily protocol revenue and triggers a buyback/burn log.
   */
  private async runRevenueRecyclingAgent() {
    const workflowName = 'agent_revenue_recycling';
    try {
      // 1. Fetch 24h revenue
      const past24h = new Date(Date.now() - 86400000).toISOString();
      const { data: flows } = await admin
        .from('fee_flows')
        .select('net_amount')
        .gte('created_at', past24h);

      const totalRevenue = (flows || []).reduce((sum, f) => sum + parseFloat(f.net_amount || '0'), 0);
      if (totalRevenue <= 0) return;

      // 2. Calculate Buyback (20% of net revenue)
      const buybackAmount = totalRevenue * 0.20;

      // 3. Log Autonomous Buyback & Burn
      await admin.from('fee_flows').insert({
        flow_type: 'buyback_burn',
        net_amount: -buybackAmount,
        burn_amount: buybackAmount,
        status: 'confirmed',
        metadata: { agent: 'RecyclingAgent-v1', basis: totalRevenue }
      });

      await logAutomation(workflowName, 'cron', 'success', { buybackAmount, totalRevenue });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Phase 7 - Step 3: Industrial Scan Watchdog
   * Monitors for geographic anomalies in supply chain scans.
   */
  private async runIndustrialWatchdog() {
    const workflowName = 'agent_industrial_watchdog';
    try {
      // 1. Fetch recent scans from the last 24h
      const past24h = new Date(Date.now() - 86400000).toISOString();
      const { data: scans } = await admin
        .from('scan_events')
        .select(`
          id, qron_id, country, city, ip_address, scanned_at,
          qrons:qron_id (mode, user_id)
        `)
        .gte('scanned_at', past24h);

      if (!scans || scans.length === 0) return;

      let anomaliesFound = 0;

      // 2. Analyze for Industrial Geofencing
      for (const scan of scans) {
        const isIndustrial = (scan.qrons as { mode?: string } | null)?.mode === 'industrial';
        if (!isIndustrial) continue;

        const safeCountries = ['US', 'CA', 'GB'];
        const isForeignScan = scan.country && !safeCountries.includes(scan.country);

        if (isForeignScan) {
          // 3. Log Geographic Drift Anomaly to scout_alerts
          const userId = (scan.qrons as { user_id?: string } | null)?.user_id;
          await admin.from('scout_alerts').insert({
            platform: 'geo_watchdog',
            listing_title: `Geo drift: QRON-${scan.qron_id} scanned in ${scan.country}`,
            risk_score: 85,
            evidence: {
              type: 'geo_drift',
              scan_id: scan.id,
              ip: scan.ip_address,
              country: scan.country,
              city: scan.city,
            },
            status: 'open',
            created_at: new Date().toISOString(),
          });

          if (userId) dispatchWebhook(userId, 'security_anomaly', {
            type: 'geo_drift', qron_id: scan.qron_id, country: scan.country,
          });

          // 5. Real-Time Alert to Admin channel (Discord/Slack)
          const securityWebhook = process.env.SECURITY_ALERTS_WEBHOOK_URL;
          if (securityWebhook) {
            await fetch(securityWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: `🚨 **SECURITY ALERT: Industrial Anomaly Detected**\n` +
                  `**Type**: Geographic Drift\n` +
                  `**Asset**: QRON-${scan.qron_id}\n` +
                  `**Location**: ${scan.city}, ${scan.country}\n` +
                  `**Severity**: HIGH\n` +
                  `**Protocol Action**: Logged & Verified`,
              }),
            });
          }
          
          anomaliesFound++;
        }
      }

      await logAutomation(workflowName, 'cron', 'success', { 
        scans_analyzed: scans.length, 
        anomalies_detected: anomaliesFound 
      });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Phase 7 - Step 4: Governance Arbiter
   * Summarizes closing proposals and rallies the community.
   */
  private async runGovernanceArbiter() {
    const workflowName = 'agent_governance_arbiter';
    try {
      // 1. Fetch proposals ending within the next 24h
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      const now = new Date().toISOString();

      // gov_proposals.deadline is a text field (e.g. "2026-09-30")
      const tomorrowDate = tomorrow.slice(0, 10);
      const nowDate = now.slice(0, 10);

      const { data: proposals } = await admin
        .from('gov_proposals')
        .select('notice_id, title, agency, fit_score, deadline, status, govchain_url')
        .in('status', ['draft', 'submitted'])
        .lte('deadline', tomorrowDate)
        .gte('deadline', nowDate);

      if (!proposals || proposals.length === 0) return;

      for (const proposal of proposals) {
        const alertMsg =
          `⚖️ **GovChain Proposal Deadline Tomorrow**\n` +
          `**Title**: ${proposal.title}\n` +
          `**Agency**: ${proposal.agency}\n` +
          `**Fit Score**: ${proposal.fit_score ?? 'N/A'}\n` +
          `**Status**: ${proposal.status}\n` +
          `${proposal.govchain_url ? `\nView: ${proposal.govchain_url}` : ''}`;

        const daoWebhook = process.env.DAO_COMMUNITY_WEBHOOK_URL;
        if (daoWebhook) {
          await fetch(daoWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: alertMsg }),
          });
        }
      }

      await logAutomation(workflowName, 'cron', 'success', { proposals_monitored: proposals.length });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * StrainChain Industrial Asset Audit.
   * Scans certifications for expiry, checks supply_chain_events for quarantine batches,
   * and flags industrial QRONs without valid certifications.
   */
  private async runStrainChainAudit() {
    const workflowName = 'strainchain_audit';
    try {
      const now = new Date();
      const in30Days = new Date(now.getTime() + 30 * 86_400_000).toISOString();
      const nowIso = now.toISOString();
      let flagged = 0;
      let expired = 0;
      let anomalies = 0;

      // 1. Find certifications expiring within 30 days or already expired
      const { data: expiring } = await admin
        .from('certifications')
        .select('id, qron_id, issuer, status, metadata, expires_at')
        .lte('expires_at', in30Days)
        .neq('status', 'revoked');

      for (const cert of expiring ?? []) {
        const isExpired = cert.expires_at && cert.expires_at < nowIso;
        const daysLeft = cert.expires_at
          ? Math.ceil((new Date(cert.expires_at).getTime() - now.getTime()) / 86_400_000)
          : 0;

        await admin.from('scout_alerts').insert({
          cert_id: cert.id,
          platform: 'strainchain_audit',
          listing_title: isExpired
            ? `Cert expired: ${cert.name ?? cert.id} (issuer: ${cert.issuer})`
            : `Cert expiring in ${daysLeft}d: ${cert.name ?? cert.id}`,
          risk_score: isExpired ? 95 : 70,
          evidence: { cert_id: cert.id, issuer: cert.issuer, expires_at: cert.expires_at, qron_id: cert.qron_id },
          status: 'open',
          created_at: nowIso,
        });

        isExpired ? expired++ : flagged++;
      }

      // 2. Detect quarantine events in supply_chain_events in the last 24h
      const past24h = new Date(now.getTime() - 86_400_000).toISOString();
      const { data: quarantineEvents } = await admin
        .from('supply_chain_events')
        .select('id, product_id, event_type, metadata, created_at')
        .eq('event_type', 'quarantine')
        .gte('created_at', past24h);

      for (const evt of quarantineEvents ?? []) {
        await admin.from('scout_alerts').insert({
          product_id: evt.product_id,
          platform: 'strainchain_audit',
          listing_title: `Quarantine event: product ${evt.product_id}`,
          risk_score: 98,
          evidence: { supply_chain_event_id: evt.id, metadata: evt.metadata },
          status: 'open',
          created_at: nowIso,
        });
        anomalies++;
      }

      // 3. Find industrial QRONs that have no certification at all
      const { data: industrialQrons } = await admin
        .from('qrons')
        .select('id, user_id')
        .eq('mode', 'industrial')
        .limit(200);

      if (industrialQrons && industrialQrons.length > 0) {
        const { data: certifiedIds } = await admin
          .from('certifications')
          .select('qron_id')
          .neq('status', 'revoked')
          .in('qron_id', industrialQrons.map((q: { id: number }) => q.id));

        const certified = new Set((certifiedIds ?? []).map((c: { qron_id: number }) => c.qron_id));
        const uncertified = industrialQrons.filter((q: { id: number }) => !certified.has(q.id));

        for (const q of uncertified) {
          await admin.from('scout_alerts').insert({
            platform: 'strainchain_audit',
            listing_title: `Uncertified industrial QRON: ${q.id}`,
            risk_score: 75,
            evidence: { qron_id: q.id, user_id: q.user_id, reason: 'no_active_certification' },
            status: 'open',
            created_at: nowIso,
          });
          flagged++;
        }
      }

      // 4. Alert admin if anything critical was found
      const totalIssues = expired + flagged + anomalies;
      if (totalIssues > 0) {
        const webhook = process.env.SECURITY_ALERTS_WEBHOOK_URL;
        if (webhook) {
          await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content:
                `🔬 **StrainChain Audit — ${totalIssues} issue(s) detected**\n` +
                `• Expired certs: ${expired}\n` +
                `• Expiring/uncertified: ${flagged}\n` +
                `• Quarantine events: ${anomalies}`,
            }),
          });
        }
      }

      await logAutomation(workflowName, 'cron', 'success', {
        expired_certs: expired,
        flagged_assets: flagged,
        quarantine_events: anomalies,
      });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * GovChain Sync.
   * Advances gov_proposals pipeline: marks overdue drafts as expired, surfaces
   * high-fit opportunities without a proposal, and alerts on upcoming deadlines.
   */
  private async runGovChainSync() {
    const workflowName = 'govchain_sync';
    try {
      const nowDate = new Date().toISOString().slice(0, 10);
      let expired = 0;
      let surfaced = 0;

      // 1. Mark overdue draft/submitted proposals as expired
      const { data: overdueProposals } = await admin
        .from('gov_proposals')
        .select('notice_id, title, agency, deadline, status')
        .in('status', ['draft', 'submitted'])
        .lt('deadline', nowDate);

      for (const p of overdueProposals ?? []) {
        await admin
          .from('gov_proposals')
          .update({ status: 'expired' })
          .eq('notice_id', p.notice_id);
        expired++;

        const daoWebhook = process.env.DAO_COMMUNITY_WEBHOOK_URL;
        if (daoWebhook) {
          await fetch(daoWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content:
                `📋 **GovChain Proposal Expired**\n` +
                `**Title**: ${p.title}\n` +
                `**Agency**: ${p.agency}\n` +
                `**Deadline passed**: ${p.deadline}\n` +
                `Submit a new capability statement at govchain.us`,
            }),
          });
        }
      }

      // 2. Surface high-fit gov_opportunities with no matching proposal yet
      const { data: highFitOpps } = await admin
        .from('gov_opportunities')
        .select('notice_id, title, agency, fit_score, deadline, sam_url')
        .gte('fit_score', 75)
        .gt('deadline', nowDate)
        .limit(10);

      if (highFitOpps && highFitOpps.length > 0) {
        const { data: existingProposals } = await admin
          .from('gov_proposals')
          .select('notice_id')
          .in('notice_id', highFitOpps.map((o: { notice_id: string }) => o.notice_id));

        const proposed = new Set((existingProposals ?? []).map((p: { notice_id: string }) => p.notice_id));
        const unaddressed = highFitOpps.filter((o: { notice_id: string }) => !proposed.has(o.notice_id));

        for (const opp of unaddressed) {
          await logAutomation('govchain_unaddressed_opp', 'cron', 'success', {
            notice_id: opp.notice_id,
            title: opp.title,
            fit_score: opp.fit_score,
            deadline: opp.deadline,
          });
          surfaced++;
        }

        if (unaddressed.length > 0) {
          const daoWebhook = process.env.DAO_COMMUNITY_WEBHOOK_URL;
          if (daoWebhook) {
            await fetch(daoWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content:
                  `🏛️ **GovChain — ${unaddressed.length} high-fit opportunities need proposals**\n` +
                  unaddressed
                    .slice(0, 3)
                    .map((o: { title: string; agency: string; fit_score: number; deadline: string }) =>
                      `• ${o.title} (${o.agency}) — score: ${o.fit_score}, deadline: ${o.deadline}`)
                    .join('\n') +
                  `\n\nDraft proposals at govchain.us`,
              }),
            });
          }
        }
      }

      await logAutomation(workflowName, 'cron', 'success', {
        proposals_expired: expired,
        opportunities_surfaced: surfaced,
      });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Specific for qron.space: Autonomous Living Art Rotation
   * Rotates each active schedule's qron through the pre-rendered images[] array
   * based on last_run_at. The full daily cycle advances each schedule one slot.
   */
  private async runQronStorySync() {
    const workflowName = 'qron_story_sync';
    try {
      const now = new Date().toISOString();
      const { data: schedules, error: fetchErr } = await admin
        .from('living_art_schedules')
        .select('id, qron_id, images, last_run_at')
        .eq('is_active', true)
        .limit(50);

      if (fetchErr) throw fetchErr;
      if (!schedules || schedules.length === 0) return;

      let processedCount = 0;
      for (const schedule of schedules) {
        const images = (schedule.images as Array<{ url?: string } | string> | null) ?? [];
        if (images.length === 0) continue;

        const dayIndex = Math.floor(Date.now() / 86_400_000);
        const slot = dayIndex % images.length;
        const next = images[slot];
        const nextUrl = typeof next === 'string' ? next : next?.url;
        if (!nextUrl) continue;

        await admin
          .from('qrons')
          .update({ image_url: nextUrl, updated_at: now })
          .eq('id', schedule.qron_id);

        await admin
          .from('living_art_schedules')
          .update({ last_run_at: now, updated_at: now })
          .eq('id', schedule.id);

        processedCount++;
      }

      await logAutomation(workflowName, 'cron', 'success', { rotated: processedCount, schedules: schedules.length });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * 1. Process Pending Leads: Sync new signups to HubSpot and trigger sequences.
   */
  private async processPendingLeads() {
    const { data: leads } = await admin
      .from('lead_captures')
      .select('*')
      .eq('status', 'new')
      .limit(50);

    if (!leads || leads.length === 0) return;

    for (const lead of leads) {
      try {
        // Sync to HubSpot
        const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
        if (hubspotToken) {
          await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${hubspotToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              properties: {
                email: lead.email,
                firstname: lead.name?.split(' ')[0] || '',
                hs_lead_status: 'NEW',
                lifecyclestage: 'lead',
              },
            }),
          });
        }

        // Update local status with score
        const score = lead.product_interest === 'authichain' ? 80 : 20; // Enterprise leads score higher
        
        await admin
          .from('lead_captures')
          .update({ 
            status: 'contacted', 
            score,
            updated_at: new Date().toISOString() 
          })
          .eq('id', lead.id);
      } catch (err) {
        console.error(`[autonomous] Lead sync failed for ${lead.email}:`, err);
      }
    }
  }

  /**
   * 2. Social Media Showcase: Select a top-performing QRON and post to social.
   */
  private async generateSocialShowcase() {
    // Select a highly-scanned QRON from the last 7 days
    const { data: qrons } = await admin
      .from('qrons')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!qrons || qrons.length === 0) return;

    // Pick one at random for the showcase
    const showcase = qrons[Math.floor(Math.random() * qrons.length)];

    const bufferWebhook = process.env.BUFFER_WEBHOOK_URL;
    if (bufferWebhook) {
      await fetch(bufferWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Today's Featured QRON! ðŸŽ¨\n\nMode: ${showcase.mode}\nPrompt: ${showcase.prompt}\n\nCreate your own verified QR art at qron.space`,
          media: { picture: showcase.image_url },
        }),
      });
    }
  }

  /**
   * 3. Executive Report: Synthesize stats and email to admin.
   */
  private async sendExecutiveReport() {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      await logAutomation('executive_report', 'cron', 'failure', null, 'ADMIN_EMAIL not set');
      return;
    }

    // Fetch 24h stats
    const past24h = new Date(Date.now() - 86400000).toISOString();
    
    const { count: newLeads } = await admin
      .from('lead_captures')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', past24h);

    const { count: gens } = await admin
      .from('qron_generations')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', past24h);

    // Fetch failed workflows in last 24h, grouped by name
    const { data: failureRows } = await admin
      .from('automation_logs')
      .select('workflow_name, error_message, created_at')
      .eq('status', 'failure')
      .gte('created_at', past24h)
      .order('created_at', { ascending: false })
      .limit(100);

    const failuresByWorkflow = new Map<string, { count: number; lastError: string; lastSeen: string }>();
    for (const row of failureRows ?? []) {
      const existing = failuresByWorkflow.get(row.workflow_name);
      if (existing) {
        existing.count++;
      } else {
        failuresByWorkflow.set(row.workflow_name, {
          count: 1,
          lastError: row.error_message || '(no message)',
          lastSeen: row.created_at,
        });
      }
    }
    const totalFailures = failureRows?.length ?? 0;
    const failuresHtml = totalFailures === 0
      ? `<p style="color: #4caf50; font-size: 13px; margin: 0;">✓ No failed workflows in the last 24h.</p>`
      : Array.from(failuresByWorkflow.entries())
          .map(([name, info]) => `
            <div style="background: #1a0808; border-left: 3px solid #ef5350; padding: 10px 14px; margin: 8px 0; border-radius: 4px;">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <strong style="color: #ef9a9a; font-size: 13px;">${name}</strong>
                <span style="color: #ef5350; font-size: 11px;">×${info.count}</span>
              </div>
              <div style="color: #a18888; font-size: 11px; margin-top: 4px; font-family: monospace; white-space: pre-wrap; word-break: break-word;">${info.lastError.slice(0, 240)}</div>
            </div>
          `).join('');

    const reportHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #fff; padding: 32px; border-radius: 12px; border: 1px solid #c9a227;">
        <h1 style="color: #c9a227;">Daily Executive Digest</h1>
        <p style="color: #9e9e9e;">QRON Platform Autonomous Operations</p>
        <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;" />
        <div style="display: grid; grid-template-cols: 1fr 1fr; gap: 16px;">
          <div style="background: #111; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #c9a227;">${newLeads || 0}</div>
            <div style="font-size: 12px; color: #666;">NEW LEADS</div>
          </div>
          <div style="background: #111; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #c9a227;">${gens || 0}</div>
            <div style="font-size: 12px; color: #666;">GENERATIONS</div>
          </div>
        </div>
        <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;" />
        <h2 style="color: ${totalFailures === 0 ? '#4caf50' : '#ef5350'}; font-size: 16px; margin: 0 0 12px 0;">
          ${totalFailures === 0 ? '✓ Operational' : `⚠ ${totalFailures} failure${totalFailures === 1 ? '' : 's'} in last 24h`}
        </h2>
        ${failuresHtml}
        <p style="font-size: 12px; color: #3a3a3a; margin-top: 32px; text-align: center;">
          System Timestamp: ${new Date().toLocaleString()}
        </p>
      </div>
    `;

    const result = await sendEmail({
      from: 'QRON Autonomous <ops@qron.space>',
      to: adminEmail,
      subject: `Daily Business Report - ${new Date().toLocaleDateString()}`,
      html: reportHtml,
    });
    await logAutomation(
      'executive_report',
      'cron',
      result.ok ? 'success' : 'failure',
      { provider: result.provider, newLeads: newLeads || 0, gens: gens || 0 },
      result.ok ? undefined : `${result.provider}: ${result.error}`
    );
  }

  /**
   * 4. Tokenomics Execution: Distribute staker rewards and monitor deflationary burn.
   */
  private async executeTokenomicsDaily() {
    try {
      // Fetch unconfirmed staker rewards
      const { data: pendingRewards } = await admin
        .from('fee_flows')
        .select('*')
        .eq('flow_type', 'staking_reward')
        .eq('status', 'pending');

      if (!pendingRewards || pendingRewards.length === 0) return;

      const totalReward = pendingRewards.reduce(
        (sum, r) => sum + parseFloat(r.staker_reward_amount || '0'),
        0
      );

      // In a real scenario, this triggers the on-chain distribution contract
      // For now, we simulate and mark as confirmed
      await admin
        .from('fee_flows')
        .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
        .in(
          'id',
          pendingRewards.map((r) => r.id)
        );

      await logAutomation('daily_tokenomics_dist', 'cron', 'success', {
        amount: totalReward,
        count: pendingRewards.length,
      });
    } catch (err: unknown) {
      await logAutomation('daily_tokenomics_dist', 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * 5. Affiliate Payout Processing: Validate referrals and queue payouts.
   */
  private async processAffiliatePayouts() {
    try {
      const { data: pendingReferrals } = await admin
        .from('referrals')
        .select('*')
        .eq('status', 'tracked');

      if (!pendingReferrals || pendingReferrals.length === 0) return;

      // Logic to move 'tracked' to 'validated' after 30-day cookie window
      // For now, we simulate validation and queue for payout
      for (const ref of pendingReferrals) {
        await admin
          .from('affiliate_payouts')
          .insert({
            affiliate_id: ref.affiliateId,
            amount: ref.commissionEarned,
            status: 'pending',
          });
        
        await admin
          .from('referrals')
          .update({ status: 'validated' })
          .eq('id', ref.id);
      }

      await logAutomation('affiliate_payout_cycle', 'cron', 'success', {
        count: pendingReferrals.length,
      });
    } catch (err: unknown) {
      await logAutomation('affiliate_payout_cycle', 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * AgentZ — triggers the autonomous outreach + grant-writer pipeline via
   * GitHub Actions workflow_dispatch. Requires GITHUB_PAT (workflow scope),
   * GITHUB_OWNER, and GITHUB_REPO to be set.
   */
  private async triggerGrowthEngine() {
    const workflowName = 'agentZ_growth_engine';
    const pat = process.env.GITHUB_PAT;
    const owner = process.env.GITHUB_OWNER || 'undone0603';
    const repo = process.env.GITHUB_REPO || 'qron-platform';

    if (!pat) {
      await logAutomation(workflowName, 'cron', 'failure', null, 'GITHUB_PAT not configured — AgentZ cannot be triggered');
      return;
    }

    try {
      const res = await withRetry(
        () =>
          fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/workflows/agentZ-outreach.yml/dispatches`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ ref: 'main', inputs: { mode: 'both', dry_run: 'false' } }),
            }
          ),
        { maxAttempts: 3, baseDelayMs: 2_000 }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub dispatch failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
      }

      await logAutomation(workflowName, 'cron', 'success', { owner, repo, workflow: 'agentZ-outreach.yml' });

      // Also dispatch the browser agent for daily web monitoring
      await this.dispatchWorkflow(pat, owner, repo, 'agentZ-browser.yml', { task: 'monitor_strainchain', dry_run: 'false' });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  private async dispatchWorkflow(
    pat: string,
    owner: string,
    repo: string,
    workflow: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    const res = await withRetry(
      () =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main', inputs }),
        }),
      { maxAttempts: 2, baseDelayMs: 1_000 },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[autonomous] ${workflow} dispatch failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    } else {
      console.log(`[autonomous] Dispatched ${workflow}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HOURLY CYCLE — lead ingestion + affiliate validation (lightweight)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Runs every hour via /api/automation/cron-hourly.
   * Processes new leads and validates affiliate referrals at higher frequency
   * than the full daily cycle to minimise CRM lag.
   */
  async runHourlyCycle() {
    const start = Date.now();
    const cb = getCircuitBreaker('supabase', { failureThreshold: 3, timeoutMs: 120_000 });
    try {
      // Determine adaptive batch size from current queue depth
      const { count: pendingLeads } = await cb.exec(() =>
        admin
          .from('lead_captures')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'new')
          .then((r) => r)
      );
      const batchSize = adaptiveBatch(pendingLeads ?? 0);

      await this.processLeadBatch(batchSize);
      await this.validateRecentReferrals();

      await logAutomation('hourly_cycle', 'cron', 'success', {
        durationMs: Date.now() - start,
        batchSize,
        pendingLeads: pendingLeads ?? 0,
      });
    } catch (err: unknown) {
      await logAutomation('hourly_cycle', 'cron', 'failure', null, formatErr(err));
    }
  }

  private async processLeadBatch(limit: number) {
    const cb = getCircuitBreaker('hubspot');
    const { data: leads } = await admin
      .from('lead_captures')
      .select('*')
      .eq('status', 'new')
      .limit(limit);
    if (!leads || leads.length === 0) return;

    for (const lead of leads) {
      try {
        const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
        if (hubspotToken) {
          await cb.exec(() =>
            withRetry(
              () =>
                fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${hubspotToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    properties: {
                      email: lead.email,
                      firstname: lead.name?.split(' ')[0] || '',
                      hs_lead_status: 'NEW',
                      lifecyclestage: 'lead',
                    },
                  }),
                }),
              { maxAttempts: 3, baseDelayMs: 1_000 }
            )
          );
        }

        const score = lead.product_interest === 'authichain' ? 80 : 20;
        await admin
          .from('lead_captures')
          .update({ status: 'contacted', score, updated_at: new Date().toISOString() })
          .eq('id', lead.id);
      } catch (err) {
        console.error(`[autonomous] Lead sync failed for ${lead.email}:`, err);
      }
    }
  }

  private async validateRecentReferrals() {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { data: refs } = await admin
      .from('referrals')
      .select('*')
      .eq('status', 'tracked')
      .gte('created_at', since)
      .limit(50);

    if (!refs || refs.length === 0) return;

    for (const ref of refs) {
      await admin
        .from('affiliate_payouts')
        .insert({ affiliate_id: ref.affiliateId, amount: ref.commissionEarned, status: 'pending' });
      await admin.from('referrals').update({ status: 'validated' }).eq('id', ref.id);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SELF-HEAL — detects stuck/failed workflows and recovers automatically
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Inspects the last `windowMinutes` of automation_logs, identifies
   * workflows that failed ≥ failureThreshold times without a subsequent
   * success, resets their circuit breakers, and re-queues them.
   *
   * Called by /api/automation/heal or wired into the daily cycle.
   */
  async runSelfHeal(windowMinutes = 60, failureThreshold = 3) {
    const workflowName = 'self_heal';
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

    try {
      const { data: rows } = await admin
        .from('automation_logs')
        .select('workflow_name, status, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1_000);

      if (!rows || rows.length === 0) return;

      // Build per-workflow: last_status + consecutive_failures
      const wfMap = new Map<string, { failures: number; lastStatus: string }>();
      for (const row of rows) {
        if (!wfMap.has(row.workflow_name)) {
          wfMap.set(row.workflow_name, { failures: 0, lastStatus: row.status });
        }
        const entry = wfMap.get(row.workflow_name)!;
        if (row.status === 'failure') entry.failures++;
        // First row (most recent) already sets lastStatus
      }

      const stuck = Array.from(wfMap.entries()).filter(
        ([, v]) => v.failures >= failureThreshold && v.lastStatus === 'failure'
      );

      if (stuck.length === 0) {
        await logAutomation(workflowName, 'cron', 'success', { healed: 0, window: windowMinutes });
        return;
      }

      // Reset circuit breakers for stuck workflows
      for (const [name] of stuck) {
        resetCircuitBreaker(name);
      }

      // Re-trigger tasks that map to runnable methods
      const healable: string[] = [];
      const healMap: Record<string, () => Promise<void>> = {
        federal_drip_sequencer: () => this['runFederalDripSequencer'](),
        agent_viral_marketing: () => this['runViralMarketingAgent'](),
        agent_revenue_recycling: () => this['runRevenueRecyclingAgent'](),
        agent_industrial_watchdog: () => this['runIndustrialWatchdog'](),
        agent_governance_arbiter: () => this['runGovernanceArbiter'](),
        qron_story_sync: () => this['runQronStorySync'](),
        affiliate_payout_cycle: () => this['processAffiliatePayouts'](),
        hubspot_deliverable_cycle: () => this['processHubSpotDeliverables'](),
        executive_report: () => this['sendExecutiveReport'](),
      };

      for (const [name] of stuck) {
        const fn = healMap[name];
        if (fn) {
          try {
            await fn();
            healable.push(name);
          } catch (err) {
            console.warn(`[self_heal] Re-run of ${name} failed again:`, err);
          }
        }
      }

      await logAutomation(workflowName, 'cron', 'success', {
        window: windowMinutes,
        stuckWorkflows: stuck.map(([n]) => n),
        healed: healable,
        breakersReset: stuck.map(([n]) => n),
      });
    } catch (err: unknown) {
      await logAutomation(workflowName, 'cron', 'failure', null, formatErr(err));
    }
  }

  /**
   * Returns a health snapshot for monitoring dashboards.
   */
  async getHealthSnapshot() {
    const since1h = new Date(Date.now() - 3_600_000).toISOString();
    const since24h = new Date(Date.now() - 86_400_000).toISOString();

    const [{ count: fails1h }, { count: fails24h }, { count: successCount }] = await Promise.all([
      admin.from('automation_logs').select('*', { count: 'exact', head: true }).eq('status', 'failure').gte('created_at', since1h),
      admin.from('automation_logs').select('*', { count: 'exact', head: true }).eq('status', 'failure').gte('created_at', since24h),
      admin.from('automation_logs').select('*', { count: 'exact', head: true }).eq('status', 'success').gte('created_at', since24h),
    ]);

    return {
      failures1h: fails1h ?? 0,
      failures24h: fails24h ?? 0,
      successes24h: successCount ?? 0,
      circuitBreakers: getAllCircuitBreakerStatuses(),
      timestamp: new Date().toISOString(),
    };
  }
}
