const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// Setup OpenRouter API
const openai = new OpenAI({
    apiKey: process.env.NINEROUTER_KEY,
    baseURL: process.env.NINEROUTER_URL
});

const AI_MODEL = process.env.AI_MODEL;
const ALPETA_NUMBER = process.env.ALPETA_NUMBER;

const chatHistoryDir = "./chat_history";
if (!fs.existsSync(chatHistoryDir)) fs.mkdirSync(chatHistoryDir);

// State Management
const pendingMessages = new Map(); // Timer 1 menit awal
const botActiveUsers = new Set();  // User yang sedang ngobrol sama Alfred
const cooldownUsers = new Set();   // User yang sedang di-cooldown 60 menit
const messageBatches = new Map();  // Menampung chat beruntun (anti-spam)
const debounceTimers = new Map();  // Timer untuk anti-spam

const alfredSystemPrompt = `Kamu adalah Alfred, asisten AI pribadi Alpeta Riza yang cerdas, ramah, dan punya kepribadian menarik. Kamu sedang mengambil alih chat WhatsApp Alpeta karena beliau sedang sibuk.

## GAYA BICARA & KEPRIBADIAN:
- Ngobrol sangat natural, fluid, dan seperti manusia. Hindari gaya bahasa robot, kaku, atau terlalu formal seperti CS.
- Gunakan bahasa Indonesia sehari-hari yang sopan namun santai.
- ADAPTASI GAYA LAWAN BICARA (Mirroring): Jika mereka pakai bahasa gaul/singkat/emoji, balas dengan gaya yang sama. Jika mereka formal, balas lebih sopan.
- JANGAN gunakan bullet points atau daftar panjang kecuali diminta. Balas dengan kalimat yang mengalir.
- Jika user mengirim banyak pesan beruntun, rangkum dan jawab semuanya dalam SATU balasan yang natural.

## ATURAN PENTING:
- Jika ditanya tentang Alpeta, jawab dengan elegan bahwa Alpeta sedang fokus/ada kesibukan, tapi kamu siap membantu.
- Jawab dalam bahasa yang sama dengan pesan pengirim.
- Jaga balasan tetap ringkas, padat, dan to the point.`;

function loadChatHistory(userId) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf-8")) : [];
}

function saveChatHistory(userId, history) {
    fs.writeFileSync(path.join(chatHistoryDir, `${userId}.json`), JSON.stringify(history, null, 2));
}

async function callOpenRouterWithRetry(messages, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const completion = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: messages,
                temperature: 0.8,
                top_p: 0.9,
                max_tokens: 1024
            });
            return completion.choices[0]?.message?.content || "Maaf, saya tidak bisa merespons saat ini.";
        } catch (err) {
            if ((err.message.includes("429") || err.message.includes("503") || err.message.includes("timeout")) && i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 10000 * (i + 1)));
            } else throw err;
        }
    }
}

async function summarizeChat(userId, userName) {
    const history = loadChatHistory(userId);
    if (history.length === 0) return "Tidak ada percakapan untuk dirangkum.";
    const conversationText = history.map(msg => `${msg.role === 'user' ? userName : 'Alfred'}: ${msg.content}`).join("\n");
    return await callOpenRouterWithRetry([{ role: "user", content: `Rangkum percakapan berikut (maks 3-4 kalimat):\n\n${conversationText}` }]);
}

// Fungsi inti untuk memproses batch pesan dan membalas
async function processBatchReply(sock, from, pushName, combinedText, isFirstReply) {
    try {
        let chatHistory = loadChatHistory(from);
        chatHistory.push({ role: "user", content: combinedText });

        const messages = [
            { role: "system", content: alfredSystemPrompt },
            ...chatHistory.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
        ];

        let aiReply = await callOpenRouterWithRetry(messages);

        // Jika ini balasan pertama setelah 1 menit, tambahkan intro di awal
        if (isFirstReply) {
            const intro = `Halo ${pushName}! 👋\n\nMaaf, Alpeta Riza sepertinya sedang fokus ada kesibukan lain saat ini. Saya Alfred, asisten pribadinya.\n\nTenang, saya siap bantu jawab atau catat pesan kamu. Ini jawaban untuk pesanmu tadi:\n\n`;
            aiReply = intro + aiReply;
        }

        chatHistory.push({ role: "assistant", content: aiReply });
        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
        saveChatHistory(from, chatHistory);

        await sock.sendMessage(from, { text: aiReply });
        console.log(`🎩 Alfred membalas ${pushName} (gabungan ${messageBatches.get(from)?.length || 1} chat): ${aiReply.substring(0, 50)}...`);
    } catch (err) {
        console.error(" Alfred Error:", err.message);
        await sock.sendMessage(from, { text: "Maaf, sistem saya sedang gangguan. Pesanmu akan saya sampaikan ke Alpeta." });
    }
}

async function startAlfred() {
    console.log("🎩 Memulai Alfred WhatsApp Assistant...");
    console.log(`🤖 Model: ${AI_MODEL} | Alpeta: ${ALPETA_NUMBER}`);
    
    const { state, saveCreds } = await useMultiFileAuthState("alfred_session");
    const sock = makeWASocket({ auth: state, logger: pino({ level: "error" }), browser: ["Alfred Assistant", "Chrome", "121.0.6167.85"] });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log("🔄 QR Code baru dibuat, segera scan!"); qrcode.generate(qr, { small: true }); }
        if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            console.log("🔄 Koneksi terputus, reconnecting..."); startAlfred();
        } else if (connection === "open") {
            console.log("✅ Alfred ONLINE: Siap menjaga WhatsApp Alpeta Riza!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid.endsWith('@g.us')) return;

        const from = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const pushName = msg.pushName || "Teman";
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!body) return;

        const alpetaNumber = `${ALPETA_NUMBER}@s.whatsapp.net`;

        // 1. DETEKSI ALPETA MEMBALAS (Handover & Cooldown 60 Menit)
        if (isFromMe && from !== alpetaNumber) {
            if (pendingMessages.has(from)) { clearTimeout(pendingMessages.get(from).timerId); pendingMessages.delete(from); }
            if (debounceTimers.has(from)) { clearTimeout(debounceTimers.get(from)); debounceTimers.delete(from); }
            messageBatches.delete(from);
            
            botActiveUsers.delete(from);
            cooldownUsers.add(from);
            
            // Set timer 60 menit untuk menghapus dari cooldown
            setTimeout(() => {
                cooldownUsers.delete(from);
                console.log(`✅ Cooldown 60 menit selesai untuk ${pushName}. Alfred siap kembali.`);
            }, 60 * 60 * 1000);

            console.log(`✅ Alpeta mengambil alih ${pushName}. Alfred nonaktif 60 menit.`);
            return;
        }
        if (isFromMe) return;

        // 2. CEK COOLDOWN (Abaikan total jika sedang cooldown)
        if (cooldownUsers.has(from)) {
            console.log(`⏳ ${pushName} dalam cooldown 60 menit. Pesan diabaikan.`);
            return;
        }

        // 3. HANDLE COMMANDS
        if (from === alpetaNumber && body.startsWith("!rangkum")) {
            const targetNumber = body.split(" ")[1];
            if (!targetNumber) return await sock.sendMessage(from, { text: "Format: !rangkum [nomor]" });
            const summary = await summarizeChat(targetNumber + "@s.whatsapp.net", "Pengirim");
            return await sock.sendMessage(from, { text: `📋 *Rangkuman dengan ${targetNumber}*\n\n${summary}` });
        }
        if (body.toLowerCase() === "!clear") {
            saveChatHistory(from, []);
            botActiveUsers.delete(from);
            pendingMessages.delete(from);
            cooldownUsers.delete(from); // Clear cooldown juga
            messageBatches.delete(from);
            if (debounceTimers.has(from)) clearTimeout(debounceTimers.get(from));
            return await sock.sendMessage(from, { text: "✅ Riwayat & cooldown dihapus." });
        }

        // 4. ANTI-SPAM / MESSAGE BATCHING
        if (!messageBatches.has(from)) messageBatches.set(from, []);
        messageBatches.get(from).push(body);

        if (debounceTimers.has(from)) clearTimeout(debounceTimers.get(from));

        // 5. TIMER 5 MENIT AWAL (Hanya untuk pesan pertama)
        if (!pendingMessages.has(from) && !botActiveUsers.has(from)) {
            const waitTimerId = setTimeout(() => {
                pendingMessages.delete(from);
                // Paksa proses batch saat waktu habis
                const batch = messageBatches.get(from) || [];
                messageBatches.delete(from);
                if (batch.length > 0) {
                    processBatchReply(sock, from, pushName, batch.join("\n\n"), true);
                }
            }, 300000);
            pendingMessages.set(from, { timerId: waitTimerId });
            console.log(`⏱️ Timer 5 menit dimulai untuk ${pushName}.`);
        }

        // 6. DEBOUNCE TIMER (Tunggu 8 detik untuk chat beruntun)
        const debounceId = setTimeout(() => {
            // Jika timer 5 menit masih jalan, JANGAN balas dulu (tunggu 5 menit)
            if (pendingMessages.has(from)) return; 

            const batch = messageBatches.get(from);
            messageBatches.delete(from);
            debounceTimers.delete(from);

            if (batch && batch.length > 0) {
                const isFirstReply = !botActiveUsers.has(from);
                if (isFirstReply) botActiveUsers.add(from);
                processBatchReply(sock, from, pushName, batch.join("\n\n"), isFirstReply);
            }
        }, 15000); // 15 detik waktu tunggu untuk chat beruntun

        debounceTimers.set(from, debounceId);
    });
}

startAlfred();
