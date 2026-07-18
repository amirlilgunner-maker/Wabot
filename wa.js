const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');

const CARS_FILE = '/root/carbot/cars.json';
const TRIGGER_FILE = '/root/carbot/wa_trigger.json';
const SCHEDULE_FILE = '/root/schedule.json';

// جلوگیری از کرش کامل ربات به خاطر ارورهای مدیریت‌نشده (auth timeout و مشابه)
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ خطای مدیریت‌نشده (نادیده گرفته شد، ربات به کارش ادامه می‌ده):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ خطای پیش‌بینی‌نشده (نادیده گرفته شد، ربات به کارش ادامه می‌ده):', err);
});

function loadCars() {
  if (!fs.existsSync(CARS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CARS_FILE, 'utf8'));
  } catch (e) {
    console.error('خطا در خواندن cars.json:', e.message);
    return [];
  }
}

function loadSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) return { channelId: '', jobs: [], knownCount: 0, autoInstant: true };
  const s = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  if (typeof s.knownCount !== 'number') s.knownCount = 0;
  if (typeof s.autoInstant !== 'boolean') s.autoInstant = true;
  return s;
}

function saveSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function buildCarMessage(car) {
  let msg = `🚗✨ *${car.name} ${car.model}*`;
  if (car.year) msg += ` | سال ${car.year}`;
  msg += '\n';
  const TAGS = { zero: '🆕 صفر کیلومتر', used: '🔧 کارکرده', single: '1️⃣ تکی', pair: '2️⃣ جفت' };
  if (car.tags && car.tags.length > 0) msg += car.tags.map(t => TAGS[t] || t).join(' | ') + '\n';
  msg += `━━━━━━━━━━━━━━━\n`;
  if (car.color) msg += `🎨 رنگ: *${car.color}*\n`;
  if (car.mileage) msg += `🛣 کارکرد: *${parseInt(car.mileage).toLocaleString('fa-IR')} کیلومتر*\n`;
  if (car.price) msg += `💰 قیمت: *${parseInt(car.price).toLocaleString('fa-IR')} تومان*\n`;
  if (car.options) msg += `⚙️ آپشن‌ها: ${car.options}\n`;
  if (car.description) msg += `📝 ${car.description}\n`;
  msg += `━━━━━━━━━━━━━━━\n`;
  const s = car.status === 'available' ? '✅ موجود' : '⏸ متوقف';
  msg += `${s}\n\n📞 *09132056551*\n📞 *09133100196*`;
  return msg;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 180000,
  }
});

let scheduledJobs = {};
let targetChannelId = '';
let autoInstant = true;

client.on('qr', (qr) => {
  console.log('\n📱 QR Code آماده‌ست! با گوشیت اسکن کن:\n');
  qrcode.generate(qr, { small: true });
  console.log('\n⚠️ واتساپ رو باز کن ← سه نقطه ← Linked Devices ← Link a Device\n');
});

client.on('ready', async () => {
  console.log('✅ ربات واتساپ آماده‌ست!');

  const schedule = loadSchedule();
  if (schedule.channelId) {
    targetChannelId = schedule.channelId;
    console.log(`✅ کانال تنظیم شده: ${targetChannelId}`);
  }
  autoInstant = schedule.autoInstant;

  // شروع رصد فایل موجودی برای پست فوری خودکار
  startWatchingCars();
  startWatchingTelegramTrigger();
});

client.on('message_create', async (msg) => {
  try {
    const body = (msg.body || '').trim();
    if (!msg.fromMe) return;

    // نمایش ID همین چت (بدون نیاز به getChats، پایدارتره)
    // نکته مهم: برای پیام‌های خودت (fromMe) نمی‌شه از msg.from استفاده کرد چون
    // اون شناسه خودت رو برمی‌گردونه نه شناسه چت؛ باید از msg.getChat() استفاده کرد.
    if (body === '!id') {
      try {
        const remote = msg.id && msg.id.remote;
        await msg.reply('🆔 ID این چت:\n' + (remote || 'پیدا نشد، دوباره امتحان کن'));
      } catch (e) {
        await msg.reply('❌ خطا در گرفتن شناسه: ' + (e && e.message ? e.message : 'نامشخص'));
      }
      return;
    }

    // نمایش لیست چت‌ها (ممکنه گاهی به خاطر ناسازگاری واتساپ‌وب خطا بده)
    if (body === '!chats') {
      try {
        const chats = await client.getChats();
        let list = '📋 لیست چت‌ها:\n\n';
        chats.slice(0, 20).forEach((c, i) => {
          list += `${i + 1}. ${c.name || 'بدون نام'}\nID: ${c.id._serialized}\n\n`;
        });
        await msg.reply(list || 'چتی پیدا نشد');
      } catch (e) {
        await msg.reply('❌ لیست چت‌ها در دسترس نیست.\nبه‌جاش داخل همون گروه/کانال موردنظر بنویس !id تا شناسه‌اش رو بگیری.');
      }
      return;
    }

    if (body.startsWith('!setchannel ')) {
      const channelId = body.replace('!setchannel ', '').trim();
      targetChannelId = channelId;
      const schedule = loadSchedule();
      schedule.channelId = channelId;
      saveSchedule(schedule);
      await msg.reply(`✅ کانال تنظیم شد:\n${channelId}`);
      return;
    }

    if (body === '!send') {
      if (!targetChannelId) { await msg.reply('❌ اول کانال رو تنظیم کن:\n!setchannel ID_کانال'); return; }
      const result = await sendAllToChannel();
      if (!result.ok) {
        await msg.reply(`❌ ارسال ناموفق بود:\n${result.error}\n\nاحتمالاً شناسه کانال (${targetChannelId}) درست نیست. داخل خود گروه/کانال !id رو بفرست و دوباره !setchannel کن.`);
      }
      return;
    }

    if (body.startsWith('!schedule ')) {
      const time = body.replace('!schedule ', '').trim();
      const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
      if (!timeRegex.test(time)) { await msg.reply('❌ فرمت اشتباه! مثال: !schedule 09:00'); return; }

      const [hour, minute] = time.split(':');
      if (scheduledJobs['daily']) scheduledJobs['daily'].stop();
      scheduledJobs['daily'] = cron.schedule(`${minute} ${hour} * * *`, () => {
        sendAllToChannel();
      }, { timezone: 'Asia/Tehran' });

      await msg.reply(`⏰ زمان‌بندی تنظیم شد!\nهر روز ساعت ${time} موجودی ارسال میشه.`);
      return;
    }

    if (body.startsWith('!every ')) {
      const hours = parseInt(body.replace('!every ', ''));
      if (isNaN(hours) || hours < 1) { await msg.reply('❌ عدد اشتباه! مثال: !every 3'); return; }
      if (scheduledJobs['interval']) scheduledJobs['interval'].stop();
      scheduledJobs['interval'] = cron.schedule(`0 */${hours} * * *`, () => {
        sendAllToChannel();
      }, { timezone: 'Asia/Tehran' });
      await msg.reply(`🔁 هر ${hours} ساعت موجودی ارسال میشه.`);
      return;
    }

    if (body === '!stop') {
      if (scheduledJobs['daily']) { scheduledJobs['daily'].stop(); delete scheduledJobs['daily']; }
      if (scheduledJobs['interval']) { scheduledJobs['interval'].stop(); delete scheduledJobs['interval']; }
      await msg.reply('🚫 زمان‌بندی لغو شد.');
      return;
    }

    // روشن/خاموش کردن پست فوری خودکار
    if (body === '!auto on' || body === '!auto off') {
      autoInstant = body === '!auto on';
      const schedule = loadSchedule();
      schedule.autoInstant = autoInstant;
      saveSchedule(schedule);
      await msg.reply(autoInstant ? '✅ پست فوری خودکار روشن شد.' : '🚫 پست فوری خودکار خاموش شد.');
      return;
    }

    if (body === '!status') {
      const schedule = loadSchedule();
      let s = '📊 *وضعیت ربات:*\n\n';
      s += `کانال: ${targetChannelId || 'تنظیم نشده'}\n`;
      s += `زمان‌بندی روزانه: ${scheduledJobs['daily'] ? 'فعال' : 'غیرفعال'}\n`;
      s += `زمان‌بندی بازه‌ای: ${scheduledJobs['interval'] ? 'فعال' : 'غیرفعال'}\n`;
      s += `پست فوری خودکار: ${autoInstant ? 'روشن' : 'خاموش'}\n`;
      await msg.reply(s);
      return;
    }

    if (body === '!help') {
      await msg.reply(
        `📋 *دستورات ربات واتساپ:*\n\n` +
        `!id ← گرفتن شناسه همین چت (داخل گروه/کانال بفرست)\n` +
        `!chats ← لیست چت‌ها (ممکنه گاهی کار نکنه)\n` +
        `!setchannel ID ← تنظیم کانال\n` +
        `!send ← ارسال موجودی همین الان\n` +
        `!schedule 09:00 ← هر روز ساعت مشخص\n` +
        `!every 3 ← هر ۳ ساعت\n` +
        `!auto on/off ← پست فوری خودکار موقع اضافه شدن ماشین جدید\n` +
        `!stop ← لغو زمان‌بندی\n` +
        `!status ← وضعیت فعلی ربات`
      );
      return;
    }
  } catch (err) {
    console.error('خطا در پردازش پیام:', err.message);
  }
});

async function sendAllToChannel() {
  if (!targetChannelId) return { ok: false, error: 'کانال تنظیم نشده', sent: 0 };
  const cars = loadCars().filter(c => c.status === 'available');
  if (cars.length === 0) return { ok: false, error: 'هیچ ماشین موجودی در cars.json نیست', sent: 0 };

  let sentCount = 0;
  for (const car of cars) {
    try {
      const text = buildCarMessage(car);
      await client.sendMessage(targetChannelId, text);
      sentCount++;
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) { console.error('خطا در ارسال یک ماشین:', e.message); }
  }
  console.log(`[${new Date().toLocaleString('fa-IR')}] ${sentCount} ماشین در واتساپ ارسال شد.`);
  return { ok: sentCount > 0, error: sentCount === 0 ? 'هیچ ماشینی ارسال نشد' : null, sent: sentCount };
}

// --- رصد خودکار cars.json برای پست فوری ماشین‌های تازه‌اضافه‌شده ---
function startWatchingCars() {
  const schedule = loadSchedule();
  let knownCount = schedule.knownCount || 0;

  // اگه اولین بارِ اجراست، تعداد فعلی رو به‌عنوان مبنا ذخیره کن (نه اینکه همه رو یهو پست کنه)
  if (knownCount === 0) {
    knownCount = loadCars().length;
    schedule.knownCount = knownCount;
    saveSchedule(schedule);
  }

  let debounceTimer = null;

  const checkForNewCars = async () => {
    if (!autoInstant) return;
    const cars = loadCars();
    if (cars.length > knownCount) {
      const newCars = cars.slice(knownCount).filter(c => c.status === 'available');
      knownCount = cars.length;
      const s = loadSchedule();
      s.knownCount = knownCount;
      saveSchedule(s);

      if (targetChannelId && newCars.length > 0) {
        for (const car of newCars) {
          try {
            await client.sendMessage(targetChannelId, '🆕 *ماشین جدید اضافه شد!*\n\n' + buildCarMessage(car));
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) { console.error('خطا در پست فوری:', e.message); }
        }
        console.log(`[${new Date().toLocaleString('fa-IR')}] ${newCars.length} ماشین جدید فوری پست شد.`);
      }
    } else if (cars.length !== knownCount) {
      // تعداد کم شده (ماشین حذف شده) یا فقط ادیت شده؛ فقط شمارش رو به‌روز کن
      knownCount = cars.length;
      const s = loadSchedule();
      s.knownCount = knownCount;
      saveSchedule(s);
    }
  };

  fs.watch(CARS_FILE, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkForNewCars, 1000);
  });

  console.log('👀 رصد فایل موجودی برای پست فوری فعال شد.');
}

// --- رصد فایل علامت مشترک: وقتی ربات تلگرام موجودی رو ارسال می‌کنه (دستی یا زمان‌بندی)، اینجا هم ارسال کن ---
function startWatchingTelegramTrigger() {
  if (!fs.existsSync(TRIGGER_FILE)) {
    try { fs.writeFileSync(TRIGGER_FILE, JSON.stringify({ ts: Date.now() }), 'utf8'); } catch (e) { return; }
  }

  let lastTs = 0;
  try { lastTs = JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf8')).ts || 0; } catch (e) {}

  let debounceTimer = null;
  const checkTrigger = async () => {
    if (!autoInstant || !targetChannelId) return;
    let ts = 0;
    try { ts = JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf8')).ts || 0; } catch (e) { return; }
    if (ts > lastTs) {
      lastTs = ts;
      console.log('📢 تلگرام موجودی رو ارسال کرد، واتساپ هم آپدیت میشه...');
      await sendAllToChannel();
    }
  };

  fs.watch(TRIGGER_FILE, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkTrigger, 1000);
  });

  console.log('📡 رصد سیگنال تلگرام فعال شد.');
}

client.initialize();
console.log('🚀 ربات واتساپ در حال راه‌اندازی...');
