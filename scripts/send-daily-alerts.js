/**
 * Daily Multi-Channel Vehicle Expiry Alert Runner (Telegram & WhatsApp)
 * 
 * Runs automatically via GitHub Actions (or standalone Node.js)
 * Fetches workspaces registered for alerts from Firebase RTDB,
 * analyzes vehicle document expiration dates, and sends formatted
 * alerts to the fleet manager via Telegram Bot and/or WhatsApp.
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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function main() {
  console.log('==================================================');
  console.log('🚀 Daily Vehicle Expiry Alert Runner (Telegram & WhatsApp)');
  console.log(`⏰ Time: ${new Date().toISOString()}`);
  console.log('==================================================');

  let workspaceKeys = [];

  if (process.env.WORKSPACE_KEYS) {
    workspaceKeys = process.env.WORKSPACE_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    console.log(`📋 Found ${workspaceKeys.length} workspaces from WORKSPACE_KEYS env var.`);
  } else {
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
    const tgConfig = data.telegramConfig;
    const waConfig = data.alertConfig;

    const isTgActive = tgConfig && tgConfig.enabled && tgConfig.botToken && tgConfig.chatId;
    const isWaActive = waConfig && waConfig.enabled && waConfig.phone && waConfig.apiKey;

    if (!isTgActive && !isWaActive) {
      console.log(`⏭️ Neither Telegram nor WhatsApp alerts active for ${companyName} (${syncKey}). Skipping.`);
      return;
    }

    const todayIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); // YYYY-MM-DD
    const todayDisplay = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    }).format(new Date());

    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    console.log(`🚗 Inspecting ${vehicles.length} vehicles for ${companyName}...`);

    const now = new Date();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 1. Process Telegram Alerts
    if (isTgActive) {
      const noticeDays = tgConfig.noticeDays || 7;
      if (tgConfig.lastAlertDate === todayIST && !process.env.FORCE_SEND) {
        console.log(`⏭️ Telegram alert already sent today (${todayIST}) for ${companyName}. Skipping.`);
      } else {
        const { expiredVehicles, expiringVehicles } = categorizeAlertItems(vehicles, nowMidnight, noticeDays);
        const totalAlerts = expiredVehicles.length + expiringVehicles.length;
        if (totalAlerts > 0) {
          console.log(`🚨 Found ${totalAlerts} alerts (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring in ${noticeDays}d) for Telegram (${companyName}).`);
          await dispatchTelegramAlert(companyName, tgConfig, expiredVehicles, expiringVehicles, todayDisplay, todayIST, syncKey, noticeDays);
        } else {
          console.log(`✨ All vehicle documents valid for ${companyName}. No Telegram alert needed.`);
        }
      }
    }

    // 2. Process WhatsApp Alerts
    if (isWaActive) {
      const noticeDays = waConfig.noticeDays || 7;
      if (waConfig.lastAlertDate === todayIST && !process.env.FORCE_SEND) {
        console.log(`⏭️ WhatsApp alert already sent today (${todayIST}) for ${companyName}. Skipping.`);
      } else {
        const { expiredVehicles, expiringVehicles } = categorizeAlertItems(vehicles, nowMidnight, noticeDays);
        const totalAlerts = expiredVehicles.length + expiringVehicles.length;
        if (totalAlerts > 0) {
          console.log(`🚨 Found ${totalAlerts} alerts (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring in ${noticeDays}d) for WhatsApp (${companyName}).`);
          await dispatchWhatsAppAlert(companyName, waConfig, expiredVehicles, expiringVehicles, todayDisplay, todayIST, syncKey, noticeDays);
        } else {
          console.log(`✨ All vehicle documents valid for ${companyName}. No WhatsApp alert needed.`);
        }
      }
    }

  } catch (err) {
    console.error(`❌ Error processing workspace ${syncKey}:`, err);
  }
}

const ALERT_NUM_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function getAlertNumIcon(idx) {
  return ALERT_NUM_ICONS[idx] || `${idx + 1}.`;
}

function categorizeAlertItems(vehicles, nowMidnight, noticeDays) {
  const expiredVehicles = [];
  const expiringVehicles = [];

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
        const statusText = daysAgo === 0 ? 'Expired Today' : `Expired ${daysAgo}d ago`;
        expiredDocs.push({
          label: f.label,
          statusText,
          dateStr: dStr
        });
      } else if (diffDays <= noticeDays) {
        const statusText = diffDays === 1 ? 'Expires Tomorrow' : `Expires in ${diffDays}d`;
        expiringDocs.push({
          label: f.label,
          statusText,
          dateStr: dStr
        });
      }
    }

    const regNo = v.vehicleNo || 'Unknown';
    const makeModel = [v.make, v.model].filter(Boolean).join(' ') || '';

    if (expiredDocs.length > 0) {
      expiredVehicles.push({
        regNo,
        makeModel,
        docs: expiredDocs
      });
    }

    if (expiringDocs.length > 0) {
      expiringVehicles.push({
        regNo,
        makeModel,
        docs: expiringDocs
      });
    }
  }

  return { expiredVehicles, expiringVehicles };
}

async function dispatchTelegramAlert(companyName, tgConfig, expiredVehicles, expiringVehicles, todayDisplay, todayIST, syncKey, noticeDays) {
  let msg = `🚨 <b>VEHICLE EXPIRY ALERT</b> 🚨\n`;
  msg += `🏢 <b>Company:</b> ${escapeHtml(companyName)}\n`;
  msg += `📅 <b>Date:</b> ${todayDisplay}\n`;

  if (expiredVehicles.length > 0) {
    msg += `\n🔴 <b>EXPIRED DOCUMENTS (${expiredVehicles.length} Vehicles):</b>\n`;
    const slice = expiredVehicles.slice(0, 10);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} <b>${escapeHtml(item.regNo)}</b>${item.makeModel ? ` (${escapeHtml(item.makeModel)})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ❌ ${escapeHtml(d.label)}: <b>${escapeHtml(d.statusText)}</b> (${escapeHtml(d.dateStr)})\n`;
      });
      msg += `\n`;
    });
    if (expiredVehicles.length > 10) {
      msg += `   <i>...and ${expiredVehicles.length - 10} more expired vehicle(s)</i>\n\n`;
    }
  }

  if (expiringVehicles.length > 0) {
    msg += `🟡 <b>EXPIRING WITHIN ${noticeDays} DAYS (${expiringVehicles.length} Vehicles):</b>\n`;
    const slice = expiringVehicles.slice(0, 10);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} <b>${escapeHtml(item.regNo)}</b>${item.makeModel ? ` (${escapeHtml(item.makeModel)})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ⚠️ ${escapeHtml(d.label)}: <b>${escapeHtml(d.statusText)}</b> (${escapeHtml(d.dateStr)})\n`;
      });
      msg += `\n`;
    });
    if (expiringVehicles.length > 10) {
      msg += `   <i>...and ${expiringVehicles.length - 10} more expiring vehicle(s)</i>\n\n`;
    }
  }

  msg += `📱 <i>Please renew expired & upcoming documents on time.</i>\n`;
  msg += `🌐 <a href="https://metro-vehicle.web.app">Open Metro Vehicle App</a>`;

  console.log(`📤 Sending Telegram alert to Chat ID: ${tgConfig.chatId}...`);
  const res = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: tgConfig.chatId,
      text: msg,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (data.ok) {
    console.log(`✅ Telegram message sent successfully!`);
    await fetch(`${FIREBASE_DB_URL}/workspaces/${syncKey}/telegramConfig/lastAlertDate.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(todayIST)
    }).catch(() => {});
  } else {
    console.error(`⚠️ Telegram API error:`, data.description);
  }
}

async function dispatchWhatsAppAlert(companyName, waConfig, expiredVehicles, expiringVehicles, todayDisplay, todayIST, syncKey, noticeDays) {
  let msg = `🚨 *VEHICLE EXPIRY ALERT* 🚨\n`;
  msg += `🏢 *Company:* ${companyName}\n`;
  msg += `📅 *Date:* ${todayDisplay}\n`;

  if (expiredVehicles.length > 0) {
    msg += `\n🔴 *EXPIRED DOCUMENTS (${expiredVehicles.length} Vehicles):*\n`;
    const slice = expiredVehicles.slice(0, 6);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} *${item.regNo}*${item.makeModel ? ` (${item.makeModel})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ❌ ${d.label}: *${d.statusText}* (${d.dateStr})\n`;
      });
      msg += `\n`;
    });
    if (expiredVehicles.length > 6) {
      msg += `   _...and ${expiredVehicles.length - 6} more expired vehicle(s)_\n\n`;
    }
  }

  if (expiringVehicles.length > 0) {
    msg += `🟡 *EXPIRING WITHIN ${noticeDays} DAYS (${expiringVehicles.length} Vehicles):*\n`;
    const slice = expiringVehicles.slice(0, 6);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} *${item.regNo}*${item.makeModel ? ` (${item.makeModel})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ⚠️ ${d.label}: *${d.statusText}* (${d.dateStr})\n`;
      });
      msg += `\n`;
    });
    if (expiringVehicles.length > 6) {
      msg += `   _...and ${expiringVehicles.length - 6} more expiring vehicle(s)_\n\n`;
    }
  }

  msg += `📱 _Please renew expired & upcoming documents on time._\n`;
  msg += `🌐 https://metro-vehicle.web.app`;

  let cleanPhone = waConfig.phone.replace(/[^0-9+]/g, '');
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  const encodedText = encodeURIComponent(msg);
  const apiUrl = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedText}&apikey=${waConfig.apiKey}`;

  console.log(`📤 Sending WhatsApp alert to ${cleanPhone}...`);
  const waRes = await fetch(apiUrl);
  const waText = await waRes.text();
  console.log(`📥 CallMeBot Response (${waRes.status}):`, waText.substring(0, 150));

  await fetch(`${FIREBASE_DB_URL}/workspaces/${syncKey}/alertConfig/lastAlertDate.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(todayIST)
  }).catch(() => {});
}

main().catch(err => {
  console.error('Fatal Runner Error:', err);
  process.exit(1);
});
