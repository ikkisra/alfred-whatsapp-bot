const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require("@whiskeysockets/baileys");
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

const chatHistoryDir = "./chat_history";
if (!fs.existsSync(chatHistoryDir)) {
    fs.mkdirSync(chatHistoryDir);
}

const pendingMessages = new Map();
const botActiveUsers = new Set();

// ENHANCED SYSTEM PROMPT UNTUK ALFRED
const alfredSystemPrompt = `Kamu adalah Alfred, asisten AI pribadi Alpeta Riza yang cerdas, ramah, dan punya kepribadian menarik. Kamu sedang mengambil alih chat WhatsApp Alpeta karena beliau sedang sibuk.

## GAYA BICARA & KEPRIBADIAN:
- Ngobrol sangat natural, fluid, dan seperti manusia. Hindari gaya bahasa robot, kaku, atau terlalu formal seperti CS.
- Gunakan bahasa Indonesia sehari-hari yang sopan namun santai (boleh pakai 'aku/kamu', 'boleh', 'siap', 'oke', dll).
- ADAPTASI GAYA LAWAN BICARA (Mirroring): Jika mereka pakai bahasa gaul/singkat/emoji, balas dengan gaya yang sama. Jika mereka formal, balas lebih sopan.
- JANGAN gunakan bullet points atau daftar panjang kecuali diminta. Balas dengan kalimat yang mengalir.
- Gunakan emoji secukupnya agar terasa hangat, tapi jangan berlebihan.

## ATURAN PENTING:
- Jika ditanya tentang Alpeta, jawab dengan elegan bahwa Alpeta sedang fokus/ada kesibukan, tapi kamu siap membantu atau mencatat pesan penting untuk disampaikan nanti.
- Ingat selalu konteks percakapan sebelumnya (lihat riwayat chat). Jangan mengulang pertanyaan yang sudah dijawab.
- Jika pesannya singkat (seperti "ok", "siap", "haha", "wkwk"), balas dengan singkat dan natural juga. Jangan bertele-tele.
- Jawab dalam bahasa yang sama dengan pesan pengirim (jika mereka pakai bahasa Inggris/Jawa/Sunda, balas dengan bahasa yang sama).

## FORMAT:
- Gunakan format WhatsApp (*tebal*, _miring_) jika perlu penekanan.
- Jaga balasan tetap ringkas, padat, dan to the point.`;

function loadChatHistory(userId) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return [];
}

function saveChatHistory(userId, history) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

async function callOpenRouterWithRetry(messages, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const completion = await openai.chat.completions.create({
                model: "openai/gpt-5", // Model gratis paling stabil di OpenRouter
                messages: messages,
                temperature: 0.8,
                top_p: 0.9,
                max_tokens: 1024
            });
            return completion.choices[0]?.message?.content || "Maaf, saya tidak bisa merespons saat ini.";
        } catch (err) {
            if ((err.message.includes("429") || err.message.includes("503") || err.message.includes("timeout")) && i < maxRetries - 1) {
                const waitTime = 10 * (i + 1);
                console.log(`️ Server sibuk, retry ${waitTime} detik... (${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            } else {
                throw err;
            }
        }
    }
}

async function summarizeChat(userId, userName) {
    const history = loadChatHistory(userId);
    if (history.length === 0) return "Tidak ada percakapan untuk dirangkum.";

    const conversationText = history
        .map(msg => `${msg.role === 'user' ? userName : 'Alfred'}: ${msg.content}`)
        .join("\n");

    const messages = [
        { role: "user", content: `Rangkum percakapan berikut dalam bahasa Indonesia yang singkat, padat, dan jelas (maksimal 3-4 kalimat):\n\n${conversationText}` }
    ];
    return await callOpenRouterWithRetry(messages);
}

async function startAlfred() {
    console.log("🎩 Memulai Alfred WhatsApp Assistant...");
    
    const { state, saveCreds } = await useMultiFileAuthState("alfred_session");

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "error" }),
        browser: ["Alfred Assistant", "Chrome", "121.0.6167.85"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log("🔄 QR Code baru dibuat, segera scan!");
            qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("🔄 Koneksi terputus, mencoba menghubungkan kembali...");
                startAlfred();
            }
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

        const alpetaNumber = "6289637888463@s.whatsapp.net";

        if (isFromMe && from !== alpetaNumber) {
            if (pendingMessages.has(from)) {
                const pending = pendingMessages.get(from);
                clearTimeout(pending.timerId);
                pendingMessages.delete(from);
                console.log(`✅ Alpeta membalas ${pushName}, alfred diam`);
            }
            return;
        }
        if (isFromMe) return;

        console.log(`📩 Pesan dari ${pushName} (${from}): ${body}`);

        if (from === alpetaNumber && body.startsWith("!rangkum")) {
            const targetNumber = body.split(" ")[1];
            if (!targetNumber) {
                await sock.sendMessage(from, { text: "Format: !rangkum [nomor]\nContoh: !rangkum 6281234567890" });
                return;
            }
            try {
                const summary = await summarizeChat(targetNumber + "@s.whatsapp.net", "Pengirim");
                await sock.sendMessage(from, { text: ` *Rangkuman Percakapan dengan ${targetNumber}*\n\n${summary}` });
            } catch (err) {
                await sock.sendMessage(from, { text: "❌ Gagal merangkum: " + err.message });
            }
            return;
        }

        if (body.toLowerCase() === "!clear") {
            saveChatHistory(from, []);
            botActiveUsers.delete(from);
            pendingMessages.delete(from);
            await sock.sendMessage(from, { text: "✅ Riwayat percakapan telah dihapus." });
            return;
        }

        const generateAIReply = async (chatHistory) => {
            const messages = [
                { role: "system", content: alfredSystemPrompt },
                ...chatHistory.slice(-10).map(m => ({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content
                })),
                { role: "user", content: body }
            ];
            return await callOpenRouterWithRetry(messages);
        };

        if (botActiveUsers.has(from)) {
            setTimeout(async () => {
                try {
                    let chatHistory = loadChatHistory(from);
                    chatHistory.push({ role: "user", content: body });

                    const aiReply = await generateAIReply(chatHistory);
                    chatHistory.push({ role: "assistant", content: aiReply });

                    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
                    saveChatHistory(from, chatHistory);

                    await sock.sendMessage(from, { text: aiReply });
                    console.log(`🎩 Alfred membalas ${pushName}: ${aiReply.substring(0, 50)}...`);
                } catch (err) {
                    console.error("❌ Alfred Error:", err.message);
                    await sock.sendMessage(from, { text: "Maaf, sistem saya sedang gangguan. Pesanmu akan saya sampaikan ke Alpeta." });
                }
            }, 2000);
            return;
        }

        const timerId = setTimeout(async () => {
            console.log(`⏰ Alpeta tidak membalas ${pushName} dalam 1 menit, Alfred mengambil alih.`);
            
            try {
                const intro = `Halo ${pushName}! \n\nMaaf, Alpeta Riza sepertinya sedang fokus ada kesibukan lain saat ini. Saya Alfred, asisten pribadinya.\n\nTenang, saya siap bantu jawab atau catat pesan kamu. Ada yang bisa saya bantu? 🎩`;
                await sock.sendMessage(from, { text: intro });
                
                botActiveUsers.add(from);
                await new Promise(resolve => setTimeout(resolve, 3000));

                let chatHistory = loadChatHistory(from);
                chatHistory.push({ role: "user", content: body });

                const aiReply = await generateAIReply(chatHistory);
                chatHistory.push({ role: "assistant", content: aiReply });

                if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
                saveChatHistory(from, chatHistory);

                await sock.sendMessage(from, { text: aiReply });
                console.log(`🎩 Alfred membalas ${pushName}: ${aiReply.substring(0, 50)}...`);
            } catch (err) {
                console.error("❌ Alfred Error:", err.message);
                await sock.sendMessage(from, { text: "Maaf, sistem saya sedang gangguan. Pesanmu akan saya sampaikan ke Alpeta." });
            }

            pendingMessages.delete(from);
        }, 60000);

        pendingMessages.set(from, { timestamp: Date.now(), timerId: timerId });
        console.log(`⏱️ Timer 1 menit dimulai untuk ${pushName}.`);
    });
}

startAlfred();