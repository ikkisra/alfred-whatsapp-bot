const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
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

// --- BLACKLIST SYSTEM ---
const blacklistFile = path.join(__dirname, 'blacklist.json');
let blacklist = fs.existsSync(blacklistFile) ? JSON.parse(fs.readFileSync(blacklistFile, 'utf-8')) : [];

function saveBlacklist() { fs.writeFileSync(blacklistFile, JSON.stringify(blacklist, null, 2)); }
function isBlacklisted(jid) { return blacklist.includes(jid.split('@')[0]); }
function addToBlacklist(jid) {
    const num = jid.split('@')[0];
    if (!blacklist.includes(num)) { blacklist.push(num); saveBlacklist(); return true; }
    return false;
}
function removeFromBlacklist(jid) {
    const num = jid.split('@')[0];
    const index = blacklist.indexOf(num);
    if (index > -1) { blacklist.splice(index, 1); saveBlacklist(); return true; }
    return false;
}
// ------------------------

// State Management
const pendingMessages = new Map();
const botActiveUsers = new Set();
const cooldownUsers = new Set();
const messageBatches = new Map();
const debounceTimers = new Map();
const nameToNumberMap = new Map();

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

function updateNameMapping(pushName, number) {
    if (!pushName || pushName === "Teman") return;
    const normalizedName = pushName.toLowerCase().trim();
    if (!nameToNumberMap.has(normalizedName)) nameToNumberMap.set(normalizedName, new Set());
    nameToNumberMap.get(normalizedName).add(number);
}

function findNumbersByName(searchName) {
    const normalizedSearch = searchName.toLowerCase().trim();
    const results = [];
    for (const [name, numbers] of nameToNumberMap.entries()) {
        if (name.includes(normalizedSearch)) results.push({ name, numbers: Array.from(numbers) });
    }
    return results;
}

async function callOpenRouterWithRetry(messages, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const completion = await openai.chat.completions.create({
                model: AI_MODEL, messages: messages, temperature: 0.8, top_p: 0.9, max_tokens: 1024
            });
            return completion.choices[0]?.message?.content || "Maaf, saya tidak bisa merespons saat ini.";
        } catch (err) {
            console.error(`❌ AI Error (attempt ${i + 1}/${maxRetries}):`, err.message);
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

async function processBatchReply(sock, from, pushName, combinedText, isFirstReply) {
    try {
        let chatHistory = loadChatHistory(from);
        chatHistory.push({ role: "user", content: combinedText });

        const messages = [
            { role: "system", content: alfredSystemPrompt },
            ...chatHistory.slice(-10).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
        ];

        let aiReply = await callOpenRouterWithRetry(messages);

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
        console.error("❌ Alfred Error:", err.message);
        try { await sock.sendMessage(from, { text: "Maaf, sistem saya sedang gangguan. Pesanmu akan saya sampaikan ke Alpeta." }); } 
        catch (sendErr) { console.error("❌ Failed to send error message:", sendErr.message); }
    }
}

async function startAlfred() {
    console.log("🎩 Memulai Alfred WhatsApp Assistant...");
    console.log(`🤖 Model: ${AI_MODEL} | Alpeta: ${ALPETA_NUMBER} | Blacklist: ${blacklist.length} user`);
    
    const { state, saveCreds } = await useMultiFileAuthState("alfred_session");
    
    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "error" })) },
        logger: pino({ level: "error" }),
        browser: ["Alfred Assistant", "Chrome", "121.0.6167.85"],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log("🔄 QR Code baru dibuat, segera scan!"); qrcode.generate(qr, { small: true }); }
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔴 Connection closed. Status code: ${statusCode}`);
            if (statusCode === DisconnectReason.loggedOut) { console.log("❌ Logged out."); process.exit(1); }
            console.log("🔄 Reconnecting in 5 seconds...");
            setTimeout(() => startAlfred(), 5000);
        } else if (connection === "open") {
            console.log("✅ Alfred ONLINE: Siap menjaga WhatsApp Alpeta Riza!");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type !== "notify") return;
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid.endsWith('@g.us')) return;

            const from = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const pushName = msg.pushName || "Teman";
            const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!body) return;

            const alpetaNumber = `${ALPETA_NUMBER}@s.whatsapp.net`;

            // 1. Update Name Mapping (Hanya untuk pesan masuk dari orang lain)
            if (!isFromMe && from !== alpetaNumber) updateNameMapping(pushName, from);

            // 2. Blacklist Check (Hanya untuk pesan masuk dari orang lain)
            if (!isFromMe && isBlacklisted(from)) {
                console.log(`⛔ [BLACKLIST] Pesan dari ${pushName} (${from}) diabaikan total.`);
                return;
            }

            // 3. COMMAND HANDLER (DIPINDAHKAN KE ATAS SEBELUM BLOKIR isFromMe)
            if (from === alpetaNumber && isFromMe) {
                if (body.startsWith("!rangkum")) {
                    const args = body.split(" ").slice(1).join(" ");
                    if (!args) return await sock.sendMessage(from, { text: "Format: !rangkum [nama/nomor]" });
                    const isNumber = /^\d+$/.test(args);
                    if (isNumber) {
                        const summary = await summarizeChat(args + "@s.whatsapp.net", "Pengirim");
                        return await sock.sendMessage(from, { text: `📋 *Rangkuman dengan ${args}*\n\n${summary}` });
                    } else {
                        const matches = findNumbersByName(args);
                        if (matches.length === 0) return await sock.sendMessage(from, { text: `❌ Tidak ditemukan percakapan dengan nama "${args}".` });
                        if (matches.length > 1) {
                            let response = `⚠️ Ditemukan ${matches.length} orang dengan nama mirip "${args}":\n\n`;
                            matches.forEach((match, idx) => response += `${idx + 1}. ${match.name} (${match.numbers.length} nomor)\n`);
                            return await sock.sendMessage(from, { text: response });
                        }
                        const match = matches[0];
                        let allSummaries = [];
                        for (const number of match.numbers) {
                            const summary = await summarizeChat(number, match.name);
                            if (summary !== "Tidak ada percakapan untuk dirangkum.") allSummaries.push(`📱 ${number.replace('@s.whatsapp.net', '')}:\n${summary}`);
                        }
                        return await sock.sendMessage(from, { text: `📋 *Rangkuman dengan ${match.name}*\n\n${allSummaries.join("\n\n")}` });
                    }
                }

                if (body.startsWith("!blacklist") || body.startsWith("!block")) {
                    const parts = body.split(" ");
                    const action = parts[1]?.toLowerCase();
                    const target = parts.slice(2).join(" ");

                    if (!action || !target) {
                        return await sock.sendMessage(from, { text: "Format:\n• !blacklist add [nomor/nama]\n• !blacklist remove [nomor/nama]\n• !blacklist list" });
                    }

                    if (action === "add") {
                        const isNumber = /^\d+$/.test(target);
                        let targetJid = isNumber ? target + "@s.whatsapp.net" : null;
                        if (!isNumber) {
                            const matches = findNumbersByName(target);
                            if (matches.length === 1 && matches[0].numbers.length === 1) targetJid = matches[0].numbers[0];
                            else return await sock.sendMessage(from, { text: "❌ Nama tidak spesifik. Gunakan nomor langsung." });
                        }
                        if (addToBlacklist(targetJid)) return await sock.sendMessage(from, { text: `✅ ${targetJid.split('@')[0]} ditambahkan ke blacklist.` });
                        else return await sock.sendMessage(from, { text: "⚠️ Nomor sudah ada di blacklist." });
                    } 
                    else if (action === "remove" || action === "unblock") {
                        const isNumber = /^\d+$/.test(target);
                        let targetJid = isNumber ? target + "@s.whatsapp.net" : null;
                        if (!isNumber) {
                            const matches = findNumbersByName(target);
                            if (matches.length === 1 && matches[0].numbers.length === 1) targetJid = matches[0].numbers[0];
                        }
                        if (targetJid && removeFromBlacklist(targetJid)) return await sock.sendMessage(from, { text: `✅ ${targetJid.split('@')[0]} dihapus dari blacklist.` });
                        else return await sock.sendMessage(from, { text: "❌ Nomor tidak ada di blacklist." });
                    } 
                    else if (action === "list") {
                        if (blacklist.length === 0) return await sock.sendMessage(from, { text: "📭 Blacklist kosong." });
                        let response = "⛔ *Daftar Blacklist:*\n\n";
                        blacklist.forEach((num, idx) => response += `${idx + 1}. ${num}\n`);
                        return await sock.sendMessage(from, { text: response });
                    }
                }

                if (body.toLowerCase() === "!clear") {
                    saveChatHistory(from, []);
                    botActiveUsers.delete(from); pendingMessages.delete(from); cooldownUsers.delete(from); messageBatches.delete(from);
                    if (debounceTimers.has(from)) clearTimeout(debounceTimers.get(from));
                    return await sock.sendMessage(from, { text: "✅ Riwayat & cooldown dihapus." });
                }
                
                if (body.toLowerCase() === "!list") {
                    if (nameToNumberMap.size === 0) return await sock.sendMessage(from, { text: "📭 Belum ada kontak yang tersimpan." });
                    let response = "📋 *Daftar Kontak yang Pernah Chat:*\n\n";
                    let idx = 1;
                    for (const [name, numbers] of nameToNumberMap.entries()) { response += `${idx}. ${name} (${numbers.size} nomor)\n`; idx++; }
                    return await sock.sendMessage(from, { text: response });
                }
                
                // Jika chat ke diri sendiri tapi bukan command, abaikan
                return; 
            }

            // 4. DETEKSI ALPETA MEMBALAS (Handover & Cooldown)
            if (isFromMe && from !== alpetaNumber) {
                if (pendingMessages.has(from)) { clearTimeout(pendingMessages.get(from).timerId); pendingMessages.delete(from); }
                if (debounceTimers.has(from)) { clearTimeout(debounceTimers.get(from)); debounceTimers.delete(from); }
                messageBatches.delete(from);
                
                botActiveUsers.delete(from);
                cooldownUsers.add(from);
                
                setTimeout(() => {
                    cooldownUsers.delete(from);
                    console.log(`✅ Cooldown 60 menit selesai untuk ${from}.`);
                }, 60 * 60 * 1000);

                console.log(`✅ Alpeta mengambil alih ${from}. Alfred nonaktif 60 menit.`);
                return;
            }

            // 5. Block pesan dari diri sendiri yang lolos (safety net)
            if (isFromMe) return;

            // 6. Cek Cooldown
            if (cooldownUsers.has(from)) {
                console.log(` ${from} dalam cooldown 60 menit. Pesan diabaikan.`);
                return;
            }

            // 7. ANTI-SPAM / MESSAGE BATCHING
            if (!messageBatches.has(from)) messageBatches.set(from, []);
            messageBatches.get(from).push(body);
            if (debounceTimers.has(from)) clearTimeout(debounceTimers.get(from));

            // 8. TIMER 5 MENIT AWAL
if (!pendingMessages.has(from) && !botActiveUsers.has(from)) {
    const waitTimerId = setTimeout(() => {
        pendingMessages.delete(from);
        const batch = messageBatches.get(from) || [];
        messageBatches.delete(from);
        if (batch.length > 0) {
            botActiveUsers.add(from); // <--- TAMBAHKAN BARIS INI
            processBatchReply(sock, from, pushName, batch.join("\n\n"), true);
        }
    }, 5 * 60 * 1000);
    pendingMessages.set(from, { timerId: waitTimerId });
    console.log(`⏱️ Timer 5 menit dimulai untuk ${from} (pushName: ${pushName}).`);
}

            // 9. DEBOUNCE TIMER (15 detik)
            const debounceId = setTimeout(() => {
                if (pendingMessages.has(from)) return;
                const batch = messageBatches.get(from);
                messageBatches.delete(from);
                debounceTimers.delete(from);
                if (batch && batch.length > 0) {
                    const isFirstReply = !botActiveUsers.has(from);
                    if (isFirstReply) botActiveUsers.add(from);
                    processBatchReply(sock, from, pushName, batch.join("\n\n"), isFirstReply);
                }
            }, 15000);
            debounceTimers.set(from, debounceId);

        } catch (err) { console.error("❌ Error in messages.upsert:", err); }
    });

    process.on('uncaughtException', (err) => console.error('❌ Uncaught Exception:', err));
    process.on('unhandledRejection', (reason, promise) => console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason));
}

startAlfred();