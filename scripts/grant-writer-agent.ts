import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * GOVCHAIN FEDERAL GRANT AUTOMATION AGENT
 * Uses Claude claude-sonnet-4-6 to draft tailored technical proposals for government grants.
 * Saves results to Supabase grant_applications and optionally pushes to HubSpot CRM.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

const DRY_RUN = process.env.DRY_RUN === 'true';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const GRANTS = [
  {
    id: 'hashgraph_2026',
    title: 'Hashgraph Association Enterprise Grant',
    value: '$750,000',
    deadline: '2026-09-30',
    focus: 'Enterprise adoption of decentralized ledger technology for supply chain provenance.',
    requirements: ['High-throughput validation', 'Immutable audit trails', 'Industrial scalability'],
    agency: 'Hashgraph Association',
    contact_email: 'grants@hedera.com',
  },
  {
    id: 'apex_accelerator_q2',
    title: 'APEX Accelerators DLA Pilot',
    value: '$175,000',
    deadline: '2026-07-15',
    focus: 'Enhancing Defense Logistics Agency (DLA) procurement security and anti-counterfeiting measures.',
    requirements: ['NIST SP 800-131A compliance', 'Domestic origin verification (Made in USA)', 'Hardware-free node deployment'],
    agency: 'Defense Logistics Agency / APEX Accelerators',
    contact_email: 'apex@dla.mil',
  },
  {
    id: 'sbir_phase1_q3',
    title: 'SBIR Phase I — Supply Chain Provenance',
    value: '$305,000',
    deadline: '2026-08-01',
    focus: 'Small Business Innovation Research for AI-augmented physical asset authentication.',
    requirements: ['Phase I feasibility study', 'Prototype deployment', 'Commercialization roadmap'],
    agency: 'US Department of Commerce',
    contact_email: 'sbir@commerce.gov',
  },
];

async function callClaude(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — using template fallback');
    return '';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find((c) => c.type === 'text')?.text ?? '';
}

function templateProposal(grant: typeof GRANTS[0]): string {
  return `EXECUTIVE SUMMARY: AuthiChain Protocol — ${grant.title}

1. OVERVIEW
AuthiChain proposes a cryptographic, hardware-free provenance network to address: ${grant.focus}
Leveraging Ed25519 signatures and the Polygon consensus layer, AuthiChain provides immutable,
instantaneous verification of physical assets with no proprietary scanning hardware required.

2. ALIGNMENT WITH REQUIREMENTS
${grant.requirements.map((r) => `• ${r}: Each QRON is an AI-generated cryptographic artifact serving as both a brand asset and a tamper-proof state hash.`).join('\n')}

3. DOMESTIC SECURITY & COMPLIANCE
AuthiChain's "FTC Shield" architecture cryptographically anchors domestic origin claims to
domestic manufacturing nodes, providing instant audit trails for federal procurement officers.

4. TECHNICAL ARCHITECTURE
- Cryptography: Ed25519 Curve (NIST SP 800-131A compliant)
- Data Carrier: AI-Augmented QR (Level H error correction)
- State Layer: Supabase (PostgreSQL) → Polygon Mainnet (anchoring)
- Verification: Any smartphone via QRON Elite App

5. MILESTONES
Month 1: AuthiChain White-Label SDK integration into pilot supply chain nodes
Month 2: Deployment of 100,000 unique QRONs to pilot assets
Month 3: Full audit via govchain.us DAO registry

Requesting ${grant.value} for Elite Mobile Node infrastructure and federal API gateways.`;
}

async function generateGrantProposals() {
  console.log('🏛️  GOVCHAIN GRANT WRITER AGENT STARTING...');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | LLM: ${ANTHROPIC_API_KEY ? 'Claude claude-sonnet-4-6' : 'Template fallback'}\n`);

  let drafted = 0;
  let saved = 0;
  let errors = 0;

  for (const grant of GRANTS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📜 ${grant.title} — ${grant.value}`);
    console.log(`${'='.repeat(60)}`);

    try {
      let proposalBody: string;

      if (ANTHROPIC_API_KEY) {
        console.log('   Calling Claude for tailored proposal...');
        const prompt = `You are AuthiChain's grant writer. Draft a compelling, technically precise federal grant proposal for the following opportunity.

Grant: ${grant.title}
Agency: ${grant.agency}
Value: ${grant.value}
Deadline: ${grant.deadline}
Focus: ${grant.focus}
Requirements: ${grant.requirements.join(', ')}

AuthiChain context:
- Hardware-free QR authentication using Ed25519 cryptography
- AI-augmented QR codes called "QRONs" that are both brand assets and tamper-proof state hashes
- Supabase → Polygon Mainnet anchoring for immutable audit trails
- QRON Elite App turns any smartphone into a verification node
- FTC Shield: cryptographic domestic origin verification (Made in USA compliance)
- govchain.us: DAO registry for federal procurement transparency

Write a 5-section proposal (Executive Summary, Technical Approach, Compliance, Architecture, Milestones). Be specific, cite NIST standards where relevant, and tailor the language to ${grant.agency}. Keep it under 600 words.`;

        proposalBody = await callClaude(prompt);
        console.log(`   ✅ Claude draft: ${proposalBody.length} chars`);
      } else {
        proposalBody = templateProposal(grant);
        console.log(`   ✅ Template draft: ${proposalBody.length} chars`);
      }

      drafted++;

      // Preview first 300 chars
      console.log(`\n   Preview:\n   ${proposalBody.slice(0, 300).replace(/\n/g, '\n   ')}...`);

      if (DRY_RUN) {
        console.log('\n   [DRY RUN] Skipping Supabase write.');
        continue;
      }

      // Save to grant_applications
      if (admin) {
        const { error } = await admin.from('grant_applications').upsert({
          program: grant.title,
          agency: grant.agency,
          category: 'federal',
          amount_min: Number(grant.value.replace(/[^0-9]/g, '')),
          amount_max: Number(grant.value.replace(/[^0-9]/g, '')),
          deadline: grant.deadline,
          contact_email: grant.contact_email,
          status: 'draft',
          notes: proposalBody,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'program,agency' });

        if (error) {
          console.warn(`   ⚠️  Supabase upsert failed: ${error.message}`);
        } else {
          saved++;
          console.log(`   💾 Saved to grant_applications (${grant.id})`);
        }
      }

      // Push to HubSpot as a Deal if token available
      const hubspot = process.env.HUBSPOT_ACCESS_TOKEN;
      if (hubspot) {
        const dealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hubspot}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            properties: {
              dealname: grant.title,
              pipeline: 'default',
              dealstage: 'qualifiedtobuy',
              amount: grant.value.replace(/[^0-9]/g, ''),
              closedate: new Date(grant.deadline).getTime().toString(),
              description: proposalBody.slice(0, 500),
            },
          }),
        });

        if (dealRes.ok) {
          console.log(`   📊 HubSpot deal created: ${grant.title}`);
        } else {
          console.warn(`   ⚠️  HubSpot deal creation failed: ${dealRes.status}`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`   ❌ Failed for ${grant.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✨ GRANT AGENT COMPLETE`);
  console.log(`   Drafted: ${drafted}/${GRANTS.length} | Saved: ${saved} | Errors: ${errors}`);
  console.log(`${'='.repeat(60)}`);

  if (errors > 0) process.exit(1);
}

generateGrantProposals();
