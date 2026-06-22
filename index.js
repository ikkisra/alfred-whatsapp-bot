const { default: makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

// GANTI DENGAN API KEY GEMINI KAMU
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "AIzaSyB0d9GmUpmI1FOjBccxCi35D-KLm2V2Z88");

// Folder untuk simpan riwayat percakapan
const chatHistoryDir = "./chat_history";
if (!fs.existsSync(chatHistoryDir)) {
    fs.mkdirSync(chatHistoryDir);
}

// Track pesan masuk yang belum dibalas Alpeta
// Format: Map<userId, {timestamp: number, timerId: NodeJS.Timeout}>
const pendingMessages = new Map();

// Track user yang sudah di-intro oleh bot
const botActiveUsers = new Set();

// Fungsi untuk load riwayat percakapan
function loadChatHistory(userId) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return [];
}

// Fungsi untuk save riwayat percakapan
function saveChatHistory(userId, history) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

// Fungsi untuk panggil Gemini dengan retry otomatis
async function callGeminiWithRetry(model, prompt, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (err) {
            if ((err.message.includes("503") || err.message.includes("504") || err.message.includes("timeout")) && i < maxRetries - 1) {
                const waitTime = 5 * (i + 1);
                console.log(`⚠️ Server sibuk, mencoba lagi dalam ${waitTime} detik... (Percobaan ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            } else {
                throw err;
            }
        }
    }
}

// Fungsi untuk rangkum percakapan
async function summarizeChat(userId, userName) {
    const history = loadChatHistory(userId);
    if (history.length === 0) return "Tidak ada percakapan untuk dirangkum.";

    const conversationText = history
        .map(msg => `${msg.role === 'user' ? userName : 'Alfred'}: ${msg.content}`)
        .join("\n");

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Rangkum percakapan berikut dalam bahasa Indonesia yang singkat dan jelas (maksimal 3-4 kalimat):\n\n${conversationText}`;
    
    return await callGeminiWithRetry(model, prompt);
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

        // Command khusus untuk Alpeta (ganti nomor ini dengan nomor kamu)
        const alpetaNumber = "6289637888463@s.whatsapp.net"; // GANTI DENGAN NOMOR KAMU

        // ===== DETEKSI JIKA ALPETA MEMBALAS =====
        if (isFromMe && from !== alpetaNumber) {
            // Alpeta sudah membalas pesan dari user ini
            // Hapus dari pendingMessages (batalkan timer bot)
            if (pendingMessages.has(from)) {
                const pending = pendingMessages.get(from);
                clearTimeout(pending.timerId);
                pendingMessages.delete(from);
                console.log(`✅ Alpeta membalas ${pushName}, alfred diam`);
            }
            return;
        }

        // ===== JIKA PESAN DARI USER LAIN =====
        if (isFromMe) return; // Abaikan pesan dari diri sendiri

        console.log(`📩 Pesan dari ${pushName} (${from}): ${body}`);

        // Command: !rangkum [nomor] - untuk Alpeta merangkum percakapan
        if (from === alpetaNumber && body.startsWith("!rangkum")) {
            const targetNumber = body.split(" ")[1];
            if (!targetNumber) {
                await sock.sendMessage(from, { text: "Format: !rangkum [nomor]\nContoh: !rangkum 6281234567890" });
                return;
            }
            
            try {
                const summary = await summarizeChat(targetNumber + "@s.whatsapp.net", "Pengirim");
                await sock.sendMessage(from, { text: `📋 *Rangkuman Percakapan dengan ${targetNumber}*\n\n${summary}` });
            } catch (err) {
                await sock.sendMessage(from, { text: "❌ Gagal merangkum: " + err.message });
            }
            return;
        }

        // Command: !clear - hapus riwayat percakapan dan reset status bot
        if (body.toLowerCase() === "!clear") {
            saveChatHistory(from, []);
            botActiveUsers.delete(from);
            pendingMessages.delete(from);
            await sock.sendMessage(from, { text: "✅ Riwayat percakapan telah dihapus." });
            return;
        }

        // ===== CEK APAKAH BOT SUDAH AKTIF DENGAN USER INI =====
        if (botActiveUsers.has(from)) {
            // Bot sudah介入, langsung balas tanpa delay
            setTimeout(async () => {
                try {
                    let chatHistory = loadChatHistory(from);
                    chatHistory.push({ role: "user", content: body });

                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    
                    const systemPrompt = `Kamu adalah Alfred, asisten AI pribadi Alpeta Riza. 
Tugas kamu:
1. Balas pesan dengan cerdas, sopan, dan ramah
2. Bantu jawab pertanyaan atau ngobrol santai
3. Jika ditanya tentang Alpeta, bilang Alpeta sedang sibuk dan kamu akan sampaikan pesannya
4. Jawab dalam bahasa Indonesia yang natural
5. Jangan terlalu formal, tapi tetap sopan

Riwayat percakapan sebelumnya:
${chatHistory.slice(-10).map(m => `${m.role === 'user' ? pushName : 'Alfred'}: ${m.content}`).join("\n")}`;

                    const aiReply = await callGeminiWithRetry(model, systemPrompt);
                    chatHistory.push({ role: "assistant", content: aiReply });

                    if (chatHistory.length > 20) {
                        chatHistory = chatHistory.slice(-20);
                    }
                    saveChatHistory(from, chatHistory);

                    await sock.sendMessage(from, { text: aiReply });
                    console.log(`🎩 Alfred membalas ${pushName}: ${aiReply.substring(0, 50)}...`);
                } catch (err) {
                    console.error("❌ Alfred Error:", err.message);
                    await sock.sendMessage(from, { text: "Maaf, saya sedang mengalami gangguan. Pesan kamu sudah saya catat dan akan disampaikan ke Alpeta." });
                }
            }, 2000);
            return;
        }

        // ===== CHAT PERTAMA: SET TIMER 1 MENIT =====
        // Simpan timestamp dan set timer
        const timerId = setTimeout(async () => {
            // Timer habis = Alpeta tidak membalas dalam 1 menit
            console.log(`⏰ Alpeta tidak membalas ${pushName} dalam 1 menit, akan dibalas alfred`);
            
            try {
                // Kirim intro
                const intro = `Halo ${pushName}! 👋\n\nMaaf, Alpeta Riza sepertinya sedang sibuk saat ini. Saya Alfred, asisten AI pribadi beliau.\n\nSaya akan membantu menjawab pesan kamu. Ada yang bisa saya bantu? 🎩`;
                await sock.sendMessage(from, { text: intro });
                
                // Tandai bot sudah aktif dengan user ini
                botActiveUsers.add(from);

                // Tunggu 3 detik sebelum balas pesan pertama
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Load riwayat percakapan
                let chatHistory = loadChatHistory(from);
                chatHistory.push({ role: "user", content: body });

                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                
                const systemPrompt = `Kamu adalah Alfred, asisten AI pribadi Alpeta Riza. 
Tugas kamu:
1. Balas pesan dengan cerdas, sopan, dan ramah
2. Bantu jawab pertanyaan atau ngobrol santai
3. Jika ditanya tentang Alpeta, bilang Alpeta sedang sibuk dan kamu akan sampaikan pesannya
4. Jawab dalam bahasa Indonesia yang natural
5. Jangan terlalu formal, tapi tetap sopan

Riwayat percakapan sebelumnya:
${chatHistory.slice(-10).map(m => `${m.role === 'user' ? pushName : 'Alfred'}: ${m.content}`).join("\n")}`;

                const aiReply = await callGeminiWithRetry(model, systemPrompt);
                chatHistory.push({ role: "assistant", content: aiReply });

                if (chatHistory.length > 20) {
                    chatHistory = chatHistory.slice(-20);
                }
                saveChatHistory(from, chatHistory);

                await sock.sendMessage(from, { text: aiReply });
                console.log(`🎩 Alfred membalas ${pushName}: ${aiReply.substring(0, 50)}...`);
            } catch (err) {
                console.error("❌ Alfred Error:", err.message);
                await sock.sendMessage(from, { text: "Maaf, saya sedang mengalami gangguan. Pesan kamu sudah saya catat dan akan disampaikan ke Alpeta." });
            }

            // Hapus dari pendingMessages
            pendingMessages.delete(from);
        }, 60000); // 60 detik = 1 menit

        // Simpan ke pendingMessages
        pendingMessages.set(from, {
            timestamp: Date.now(),
            timerId: timerId
        });

        console.log(`⏱️ Timer 1 menit dimulai untuk ${pushName}. Jika Alpeta tidak membalas, alfred akan membalas`);
    });
}

startAlfred();