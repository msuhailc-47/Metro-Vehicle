/**
 * Daily WhatsApp Vehicle Expiry Alert Runner
 * 
 * Runs automatically via GitHub Actions (or standalone Node.js)
 * Fetches workspaces registered for WhatsApp alerts from Firebase RTDB,
 * analyzes vehicle document expiration dates, and sends formatted WhatsApp
 * alerts to the fleet manager via CallMeBot API.
 */

const FIREBASE_DB_URL = 'https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app';

const DOC_FIELDS = [
  { key: 'fitnessUpto', label: 'Fitness' },
  { key: 'insuranceUpto', label: 'Insurance' },
  { key: 'taxUpto', label: 'Tax' },
  { key: 'permitUpto', label: 'Permit' },
  { key: 'nationalPermit', label: 'National Permit' },
  { key: 'pucc', label: 'PUCC' }
];

async function main() {
  console.log('==================================================');
  console.log('🚀 Daily WhatsApp Vehicle Expiry Alert Runner');
  console.log(`⏰ Time: ${new Date().toISOString()}`);
  console.log('==================================================');

  let workspaceKeys = [];

  // 1. Check if explicit keys passed in environment variable
  if (process.env.WORKSPACE_KEYS) {
    workspaceKeys = process.env.WORKSPACE_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    console.log(`📋 Found ${workspaceKeys.length} workspaces from WORKSPACE_KEYS env var.`);
  } else {
    // 2. Fetch registered workspaces from /alert_registry.json
    try {
      console.log('🔍 Fetching registered workspaces from alert_registry...');
      const res = await fetch(`${FIREBASE_DB_URL}/alert_registry.json`);
      if (res.ok) {
        const registry = await res.json();
        if (registry && typeof registry === 'object') {
          workspaceKeys = Object.keys(registry).filter(k => registry[k]);
        }
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch alert_registry:', err.message);
    }
  }

  // Fallback: If still empty, check MMM-1407 or default keys if present
  if (workspaceKeys.length === 0) {
    console.log('ℹ️ No active workspaces found in alert_registry. Checking common keys...');
    workspaceKeys = ['MMM-1407'];
  }

  console.log(`🏢 Workspaces to inspect: [${workspaceKeys.join(', ')}]`);

  for (const syncKey of workspaceKeys) {
    await processWorkspace(syncKey);
  }

  console.log('==================================================');
  console.log('✅ Daily Alert Runner Completed.');
  console.log('==================================================');
}

async function processWorkspace(syncKey) {
  console.log(`\n📂 Processing Workspace: ${syncKey}...`);
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/workspaces/${syncKey}.json`);
    if (!res.ok) {
      console.warn(`⚠️ Workspace ${syncKey} returned status ${res.status}. Skipping.`);
      return;
    }
    const data = await res.json();
    if (!data) {
      console.warn(`⚠️ Workspace ${syncKey} has no data.`);
      return;
    }

    const companyName = data.name || syncKey;
    const alertConfig = data.alertConfig;

    if (!alertConfig || !alertConfig.enabled) {
      console.log(`⏭️ WhatsApp alerts disabled for ${companyName} (${syncKey}). Skipping.`);
      return;
    }

    const { phone, apiKey, noticeDays = 3, lastAlertDate } = alertConfig;
    if (!phone || !apiKey) {
      console.warn(`⚠️ Incomplete phone or apiKey for ${companyName}. Skipping.`);
      return;
    }

    // Date check: Prevent duplicate alerts on same day (IST time zone)
    const todayIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); // YYYY-MM-DD
    if (lastAlertDate === todayIST && !process.env.FORCE_SEND) {
      console.log(`⏭️ Alert already sent today (${todayIST}) for ${companyName}. Skipping. (Set FORCE_SEND=1 to override).`);
      return;
    }

    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    console.log(`🚗 Inspecting ${vehicles.length} vehicles for ${companyName}...`);

    // Calculate expiry
    const now = new Date();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const alertItems = [];

    for (const v of vehicles) {
      const expiredDocs = [];
      const expiringDocs = [];

      for (const f of DOC_FIELDS) {
        const val = v[f.key];
        if (!val) continue;

        const target = new Date(val);
        if (isNaN(target.getTime())) continue;

        const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
        const diffDays = Math.ceil((targetMidnight - nowMidnight) / (1000 * 60 * 60 * 24));

        const dStr = target.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

        if (diffDays <= 0) {
          const daysAgo = Math.abs(diffDays);
          const label = daysAgo === 0 ? 'Expired Today' : `Expired ${daysAgo}d ago`;
          expiredDocs.push(`${f.label}: ${label} (${dStr})`);
        } else if (diffDays <= noticeDays) {
          expiringDocs.push(`${f.label}: Expires in ${diffDays}d (${dStr})`);
        }
      }

      if (expiredDocs.length > 0 || expiringDocs.length > 0) {
        alertItems.push({
          regNo: v.vehicleNo || 'Unknown',
          makeModel: [v.make, v.model].filter(Boolean).join(' ') || '',
          expiredDocs,
          expiringDocs
        });
      }
    }

    if (alertItems.length === 0) {
      console.log(`✨ All vehicle documents are valid for ${companyName}. No alerts needed.`);
      return;
    }

    console.log(`🚨 Found ${alertItems.length} vehicles with expired/expiring documents for ${companyName}!`);

    // Format WhatsApp Message
    const todayDisplay = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    }).format(new Date());

    let msg = `🚨 *VEHICLE EXPIRY ALERT* 🚨\n`;
    msg += `🏢 *Company:* ${companyName}\n`;
    msg += `📅 *Date:* ${todayDisplay}\n\n`;
    msg += `⚠️ *ATTENTION NEEDED (${alertItems.length} Vehicles):*\n\n`;

    const maxDisplay = 8;
    const displayItems = alertItems.slice(0, maxDisplay);

    displayItems.forEach((item, idx) => {
      msg += `${idx + 1}️⃣ *${item.regNo}*${item.makeModel ? ` (${item.makeModel})` : ''}\n`;
      item.expiredDocs.forEach(d => {
        msg += `   ❌ ${d}\n`;
      });
      item.expiringDocs.forEach(d => {
        msg += `   ⚠️ ${d}\n`;
      });
      msg += `\n`;
    });

    if (alertItems.length > maxDisplay) {
      msg += `➕ *And ${alertItems.length - maxDisplay} more vehicles.* View full list in app.\n\n`;
    }

    msg += `📱 _Please renew expired documents immediately to avoid fine/penalty._\n`;
    msg += `🌐 https://metro-vehicle.web.app`;

    // Dispatch to CallMeBot API
    let cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
    const encodedText = encodeURIComponent(msg);
    const apiUrl = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedText}&apikey=${apiKey}`;

    console.log(`📤 Sending WhatsApp alert to ${cleanPhone}...`);
    const waRes = await fetch(apiUrl);
    const waText = await waRes.text();

    console.log(`📥 CallMeBot Response (${waRes.status}):`, waText.substring(0, 150));

    // Update lastAlertDate in Firebase RTDB
    try {
      await fetch(`${FIREBASE_DB_URL}/workspaces/${syncKey}/alertConfig/lastAlertDate.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(todayIST)
      });
      console.log(`💾 Updated lastAlertDate to ${todayIST}`);
    } catch (saveErr) {
      console.warn('⚠️ Could not update lastAlertDate in Firebase:', saveErr.message);
    }

  } catch (err) {
    console.error(`❌ Error processing workspace ${syncKey}:`, err);
  }
}

main().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
