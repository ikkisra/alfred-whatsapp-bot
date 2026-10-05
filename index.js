const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const knowledgeIndexDir = path.join(appDir, "knowledge_data");
const knowledgeIndexFile = path.join(
    knowledgeIndexDir,
    "knowledge_index.json"
);


// =========================
// CONFIGURATION
// =========================

const requiredEnv = [
    "NINEROUTER_KEY",
    "NINEROUTER_URL",
    "AI_MODEL",
    "ALPETA_NUMBER"
];

for (const key of requiredEnv) {
    if (!process.env[key]) {
        throw new Error(`Environment variable ${key} belum diset`);
    }
}

console.log("✅ Konfigurasi environment terbaca:");
console.log("   AI URL:", process.env.NINEROUTER_URL);
console.log("   AI Model:", process.env.AI_MODEL);
console.log("   API Key:", process.env.NINEROUTER_KEY ? "TERBACA" : "KOSONG");

// Setup OpenRouter API
const openai = new OpenAI({
    apiKey: process.env.NINEROUTER_KEY,
    baseURL: process.env.NINEROUTER_URL,
    timeout: 120000,
    maxRetries: 0
});

const AI_MODEL = process.env.AI_MODEL;
const ALPETA_NUMBER = process.env.ALPETA_NUMBER;

const EMBEDDING_MODEL = process.env.NINEROUTER_EMBEDDING_MODEL;

if (!EMBEDDING_MODEL ) {
    throw new Error("Environment variable NINEROUTER_EMBEDDING_MODEL belum diset");
}

const knowledgeDir = path.join(appDir, "knowledge");
const knowledgeIndexFile = path.join(knowledgeIndexDir, "knowledge_index.json");

if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
}

let knowledgeIndex = [];

const appDir = __dirname;
const sessionDir = path.join(appDir, "alfred_session");
const chatHistoryDir = path.join(appDir, "chat_history");

if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
if (!fs.existsSync(chatHistoryDir)) fs.mkdirSync(chatHistoryDir, { recursive: true });

// =========================
// BLACKLIST SYSTEM
// =========================

const blacklistFile = path.join(appDir, "blacklist.json");
let blacklist = fs.existsSync(blacklistFile)
    ? JSON.parse(fs.readFileSync(blacklistFile, "utf-8"))
    : [];

function saveBlacklist() {
    fs.writeFileSync(blacklistFile, JSON.stringify(blacklist, null, 2));
}

function isBlacklisted(jid) {
    return blacklist.includes(jid.split("@")[0]);
}

function addToBlacklist(jid) {
    const num = jid.split("@")[0];
    if (!blacklist.includes(num)) {
        blacklist.push(num);
        saveBlacklist();
        return true;
    }
    return false;
}

function removeFromBlacklist(jid) {
    const num = jid.split("@")[0];
    const index = blacklist.indexOf(num);

    if (index > -1) {
        blacklist.splice(index, 1);
        saveBlacklist();
        return true;
    }

    return false;
}

// =========================
// STATE MANAGEMENT
// =========================

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

// =========================
// CHAT HISTORY
// =========================

function loadChatHistory(userId) {
    const filePath = path.join(chatHistoryDir, `${userId}.json`);

    if (!fs.existsSync(filePath)) return [];

    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (error) {
        console.error(`❌ Gagal membaca history ${userId}:`, error.message);
        return [];
    }
}

function saveChatHistory(userId, history) {
    fs.writeFileSync(
        path.join(chatHistoryDir, `${userId}.json`),
        JSON.stringify(history, null, 2)
    );
}

function updateNameMapping(pushName, number) {
    if (!pushName || pushName === "Teman") return;

    const normalizedName = pushName.toLowerCase().trim();

    if (!nameToNumberMap.has(normalizedName)) {
        nameToNumberMap.set(normalizedName, new Set());
    }

    nameToNumberMap.get(normalizedName).add(number);
}

function findNumbersByName(searchName) {
    const normalizedSearch = searchName.toLowerCase().trim();
    const results = [];

    for (const [name, numbers] of nameToNumberMap.entries()) {
        if (name.includes(normalizedSearch)) {
            results.push({
                name,
                numbers: Array.from(numbers)
            });
        }
    }

    return results;
}

// =========================
// RAG / KNOWLEDGE BASE
// =========================

function splitTextIntoChunks(text, maxCharacters = 1200) {
    const normalizedText = text
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!normalizedText) return [];

    const paragraphs = normalizedText
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);

    const chunks = [];
    let currentChunk = "";

    for (const paragraph of paragraphs) {
        const candidate = currentChunk
            ? `${currentChunk}\n\n${paragraph}`
            : paragraph;

        if (candidate.length <= maxCharacters) {
            currentChunk = candidate;
        } else {
            if (currentChunk) {
                chunks.push(currentChunk);
            }

            // Jika satu paragraf terlalu panjang, potong berdasarkan karakter.
            if (paragraph.length > maxCharacters) {
                for (let i = 0; i < paragraph.length; i += maxCharacters) {
                    chunks.push(paragraph.slice(i, i + maxCharacters));
                }

                currentChunk = "";
            } else {
                currentChunk = paragraph;
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

async function createEmbedding(text) {
    const result = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text
    });

    const embedding = result.data?.[0]?.embedding;

    if (!embedding) {
        throw new Error("Embedding tidak ditemukan pada response provider");
    }

    return embedding;
}

function cosineSimilarity(vectorA, vectorB) {
    if (!vectorA || !vectorB || vectorA.length !== vectorB.length) {
        return 0;
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vectorA.length; i++) {
        dotProduct += vectorA[i] * vectorB[i];
        magnitudeA += vectorA[i] * vectorA[i];
        magnitudeB += vectorB[i] * vectorB[i];
    }

    if (magnitudeA === 0 || magnitudeB === 0) {
        return 0;
    }

    return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function getKnowledgeFiles() {
    if (!fs.existsSync(knowledgeDir)) return [];

    return fs.readdirSync(knowledgeDir)
        .filter(file => /\.(txt|md|markdown)$/i.test(file))
        .map(file => path.join(knowledgeDir, file));
}

async function buildKnowledgeIndex() {
    const files = getKnowledgeFiles();

    if (files.length === 0) {
        console.log("⚠️ Folder knowledge kosong. RAG belum memiliki dokumen.");
        knowledgeIndex = [];
        return;
    }

    console.log(`📚 Membangun knowledge index dari ${files.length} file...`);

    const newIndex = [];

    for (const filePath of files) {
        const fileName = path.basename(filePath);
        const text = fs.readFileSync(filePath, "utf-8");
        const chunks = splitTextIntoChunks(text);

        console.log(`📄 ${fileName}: ${chunks.length} chunk`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            try {
                const embedding = await createEmbedding(chunk);

                newIndex.push({
                    id: `${fileName}-${i}`,
                    source: fileName,
                    text: chunk,
                    embedding
                });

                console.log(`   ✅ Embedding ${i + 1}/${chunks.length}`);
            } catch (error) {
                console.error(
                    `❌ Gagal membuat embedding ${fileName} chunk ${i}:`,
                    error.message
                );
            }
        }
    }

    knowledgeIndex = newIndex;

    fs.writeFileSync(
        knowledgeIndexFile,
        JSON.stringify(knowledgeIndex, null, 2)
    );

    console.log(`✅ Knowledge index selesai: ${knowledgeIndex.length} chunk`);
}

function loadKnowledgeIndexFromDisk() {
    if (!fs.existsSync(knowledgeIndexFile)) {
        return false;
    }

    try {
        const savedIndex = JSON.parse(
            fs.readFileSync(knowledgeIndexFile, "utf-8")
        );

        if (!Array.isArray(savedIndex)) {
            return false;
        }

        knowledgeIndex = savedIndex;
        console.log(`📚 Knowledge index dimuat: ${knowledgeIndex.length} chunk`);
        return true;
    } catch (error) {
        console.error("❌ Gagal membaca knowledge index:", error.message);
        return false;
    }
}

async function initializeKnowledgeBase() {
    const loaded = loadKnowledgeIndexFromDisk();

    if (!loaded) {
        await buildKnowledgeIndex();
    }
}

async function searchKnowledge(query, topK = 4) {
    if (!knowledgeIndex.length) {
        return [];
    }

    const queryEmbedding = await createEmbedding(query);

    return knowledgeIndex
        .map(item => ({
            ...item,
            score: cosineSimilarity(queryEmbedding, item.embedding)
        }))
        .filter(item => item.score >= 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

async function getRelevantKnowledge(query) {
    try {
        const results = await searchKnowledge(query, 4);

        if (!results.length) {
            return "";
        }

        return results
            .map((item, index) => {
                return `[Referensi ${index + 1} | ${item.source} | skor ${item.score.toFixed(3)}]\n${item.text}`;
            })
            .join("\n\n");
    } catch (error) {
        console.error("❌ Gagal mencari knowledge:", error.message);
        return "";
    }
}

// =========================
// OPENROUTER / AI
// =========================

async function callOpenRouterWithRetry(messages, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const completion = await openai.chat.completions.create({
                model: AI_MODEL,
                messages,
                temperature: 0.8,
                top_p: 0.9,
                max_tokens: 512
            });

            return completion.choices[0]?.message?.content ||
                "Maaf, saya tidak bisa merespons saat ini.";
        } catch (err) {
            const status = err.status || err.code || err.response?.status;

            console.error(
                `❌ AI Error (attempt ${i + 1}/${maxRetries}): status=${status}`,
                err.message
            );

            const retryable =
                [408, 429, 500, 502, 503, 504].includes(Number(status)) ||
                /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(err.message);

            if (!retryable || i >= maxRetries - 1) {
                throw err;
            }

            const delay = 5000 * (i + 1);
            console.log(`⏳ Retry AI dalam ${delay / 1000} detik...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function summarizeChat(userId, userName) {
    const history = loadChatHistory(userId);

    if (history.length === 0) {
        return "Tidak ada percakapan untuk dirangkum.";
    }

    const conversationText = history
        .map(msg => `${msg.role === "user" ? userName : "Alfred"}: ${msg.content}`)
        .join("\n");

    return await callOpenRouterWithRetry([
        {
            role: "user",
            content: `Rangkum percakapan berikut (maks 3-4 kalimat):\n\n${conversationText}`
        }
    ]);
}

// =========================
// MESSAGE PROCESSING
// =========================

async function processBatchReply(
    sock,
    from,
    pushName,
    combinedText,
    isFirstReply,
    imageData = null
) 
 {
    try {
        let chatHistory = loadChatHistory(from);
        chatHistory.push({ role: "user", content: combinedText });

    const relevantKnowledge = await getRelevantKnowledge(combinedText);

const ragInstruction = relevantKnowledge
    ? `

## KNOWLEDGE BASE
Gunakan referensi berikut jika relevan dengan pertanyaan user.
Jangan mengarang fakta yang tidak ada di referensi.
Jika informasi tidak tersedia, katakan bahwa informasi tersebut belum tersedia.

${relevantKnowledge}
`
    : `

## KNOWLEDGE BASE
Tidak ada referensi yang relevan. Jangan mengarang informasi khusus tentang bisnis atau Alpeta.
`;

const messages = [
    {
        role: "system",
        content: `${alfredSystemPrompt}${ragInstruction}`
    },
    ...chatHistory
        .slice(-10)
        .map(m => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.content
        }))
];


        let aiReply = await callOpenRouterWithRetry(messages);

        if (isFirstReply) {
            const intro = `Halo ${pushName}! 👋\n\nMaaf, Alpeta Riza sepertinya sedang fokus ada kesibukan lain saat ini. Saya Alfred, asisten pribadinya.\n\nTenang, saya siap bantu jawab atau catat pesan kamu. Ini jawaban untuk pesanmu tadi:\n\n`;
            aiReply = intro + aiReply;
        }

        chatHistory.push({ role: "assistant", content: aiReply });

        if (chatHistory.length > 20) {
            chatHistory = chatHistory.slice(-20);
        }

        saveChatHistory(from, chatHistory);
        await sock.sendMessage(from, { text: aiReply });

        console.log(
            `🎩 Alfred membalas ${pushName} (gabungan ${messageBatches.get(from)?.length || 1} chat): ${aiReply.substring(0, 50)}...`
        );
    } catch (err) {
        console.error("❌ Alfred Error:", err.message);

        try {
            await sock.sendMessage(from, {
                text: "Maaf, sistem saya sedang gangguan. Pesanmu akan saya sampaikan ke Alpeta."
            });
        } catch (sendErr) {
            console.error("❌ Failed to send error message:", sendErr.message);
        }
    }
}

// =========================
// WHATSAPP CONNECTION
// =========================

async function startAlfred() {
    console.log("🎩 Memulai Alfred WhatsApp Assistant...");
    console.log(
        `🤖 Model: ${AI_MODEL} | Alpeta: ${ALPETA_NUMBER} | Blacklist: ${blacklist.length} user`
    );
    console.log("📁 Session directory:", sessionDir);
    console.log("📁 Chat history directory:", chatHistoryDir);
    await initializeKnowledgeBase();


    let version;
    let isLatest;

    try {
        const latestVersion = await fetchLatestBaileysVersion();
        version = latestVersion.version;
        isLatest = latestVersion.isLatest;

        console.log(
            `📱 WhatsApp Web version: ${version.join(".")} | latest: ${isLatest}`
        );
    } catch (error) {
        console.error("⚠️ Gagal mengambil versi terbaru WhatsApp Web:", error.message);
        console.log("⚠️ Baileys akan menggunakan versi default package.");
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const socketConfig = {
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: "error" })
            )
        },
        logger: pino({ level: "info" }),
        browser: Browsers.ubuntu("Chrome"),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
    };

    if (version) {
        socketConfig.version = version;
    }

    const sock = makeWASocket(socketConfig);

    sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("🔄 QR Code baru dibuat, segera scan!");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`🔴 Connection closed. Status code: ${statusCode}`);

            if (!shouldReconnect) {
                console.log("❌ Logged out. Hapus session lalu scan QR baru jika diperlukan.");
                return;
            }

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
            if (!msg?.message || msg.key.remoteJid?.endsWith("@g.us")) return;

            const from = msg.key.remoteJid;
            if (!from) return;

            const isFromMe = msg.key.fromMe;
            const pushName = msg.pushName || "Teman";
            const body = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ""
            ).trim();

            if (!body) return;

            const senderPhone = from.split("@")[0];
            const myPhone = ALPETA_NUMBER;

            // Update name mapping hanya untuk pesan masuk dari orang lain
            if (!isFromMe) {
                updateNameMapping(pushName, from);
            }

            // Blacklist check
            if (!isFromMe && isBlacklisted(from)) {
                console.log(
                    `⛔ [BLACKLIST] Pesan dari ${pushName} (${from}) diabaikan total.`
                );
                return;
            }

            // Command handler hanya untuk pesan dari diri sendiri
            if (isFromMe) {
                let isCommand = false;

                if (body.startsWith("!rangkum")) {
                    const args = body.split(" ").slice(1).join(" ");

                    if (!args) {
                        await sock.sendMessage(from, {
                            text: "Format: !rangkum [nama/nomor]"
                        });
                    } else {
                        const isNumber = /^\d+$/.test(args);

                        if (isNumber) {
                            const summary = await summarizeChat(
                                `${args}@s.whatsapp.net`,
                                "Pengirim"
                            );

                            await sock.sendMessage(from, {
                                text: `📋 *Rangkuman dengan ${args}*\n\n${summary}`
                            });
                        } else {
                            const matches = findNumbersByName(args);

                            if (matches.length === 0) {
                                await sock.sendMessage(from, {
                                    text: `❌ Tidak ditemukan percakapan dengan nama "${args}".`
                                });
                            } else if (matches.length > 1) {
                                let response = `⚠️ Ditemukan ${matches.length} orang dengan nama mirip "${args}":\n\n`;

                                matches.forEach((match, idx) => {
                                    response += `${idx + 1}. ${match.name} (${match.numbers.length} nomor)\n`;
                                });

                                await sock.sendMessage(from, { text: response });
                            } else {
                                const match = matches[0];
                                const allSummaries = [];

                                for (const number of match.numbers) {
                                    const summary = await summarizeChat(number, match.name);

                                    if (summary !== "Tidak ada percakapan untuk dirangkum.") {
                                        allSummaries.push(
                                            `📱 ${number.replace("@s.whatsapp.net", "")}:\n${summary}`
                                        );
                                    }
                                }

                                await sock.sendMessage(from, {
                                    text: `📋 *Rangkuman dengan ${match.name}*\n\n${allSummaries.join("\n\n")}`
                                });
                            }
                        }
                    }

                    isCommand = true;
                } else if (body.startsWith("!blacklist") || body.startsWith("!block")) {
                    const parts = body.split(" ");
                    const action = parts[1]?.toLowerCase();
                    const target = parts.slice(2).join(" ");

                    if (!action || !target) {
                        await sock.sendMessage(from, {
                            text: "Format:\n• !blacklist add [nomor/nama]\n• !blacklist remove [nomor/nama]\n• !blacklist list"
                        });
                    } else if (action === "add") {
                        const isNumber = /^\d+$/.test(target);
                        let targetJid = isNumber
                            ? `${target}@s.whatsapp.net`
                            : null;

                        if (!isNumber) {
                            const matches = findNumbersByName(target);

                            if (matches.length === 1 && matches[0].numbers.length === 1) {
                                targetJid = matches[0].numbers[0];
                            } else {
                                await sock.sendMessage(from, {
                                    text: "❌ Nama tidak spesifik. Gunakan nomor langsung."
                                });
                            }
                        }

                        if (targetJid) {
                            if (addToBlacklist(targetJid)) {
                                await sock.sendMessage(from, {
                                    text: `✅ ${targetJid.split("@")[0]} ditambahkan ke blacklist.`
                                });
                            } else {
                                await sock.sendMessage(from, {
                                    text: "⚠️ Nomor sudah ada di blacklist."
                                });
                            }
                        }
                    } else if (action === "remove" || action === "unblock") {
                        const isNumber = /^\d+$/.test(target);
                        let targetJid = isNumber
                            ? `${target}@s.whatsapp.net`
                            : null;

                        if (!isNumber) {
                            const matches = findNumbersByName(target);

                            if (matches.length === 1 && matches[0].numbers.length === 1) {
                                targetJid = matches[0].numbers[0];
                            }
                        }

                        if (targetJid) {
                            if (removeFromBlacklist(targetJid)) {
                                await sock.sendMessage(from, {
                                    text: `✅ ${targetJid.split("@")[0]} dihapus dari blacklist.`
                                });
                            } else {
                                await sock.sendMessage(from, {
                                    text: "❌ Nomor tidak ada di blacklist."
                                });
                            }
                        }
                    } else if (action === "list") {
                        if (blacklist.length === 0) {
                            await sock.sendMessage(from, {
                                text: "📭 Blacklist kosong."
                            });
                        } else {
                            let response = "⛔ *Daftar Blacklist:*\n\n";

                            blacklist.forEach((num, idx) => {
                                response += `${idx + 1}. ${num}\n`;
                            });

                            await sock.sendMessage(from, { text: response });
                        }
                    }

                    isCommand = true;
                } else if (body.toLowerCase() === "!clear") {
                    saveChatHistory(from, []);
                    botActiveUsers.delete(from);
                    pendingMessages.delete(from);
                    cooldownUsers.delete(from);
                    messageBatches.delete(from);

                    if (debounceTimers.has(from)) {
                        clearTimeout(debounceTimers.get(from));
                        debounceTimers.delete(from);
                    }

                    await sock.sendMessage(from, {
                        text: "✅ Riwayat & cooldown dihapus."
                    });

                    isCommand = true;
                } else if (body.toLowerCase() === "!list") {
                    if (nameToNumberMap.size === 0) {
                        await sock.sendMessage(from, {
                            text: "📭 Belum ada kontak yang tersimpan."
                        });
                    } else {
                        let response = "📋 *Daftar Kontak yang Pernah Chat:*\n\n";
                        let idx = 1;

                        for (const [name, numbers] of nameToNumberMap.entries()) {
                            response += `${idx}. ${name} (${numbers.size} nomor)\n`;
                            idx++;
                        }

                        await sock.sendMessage(from, { text: response });
                    }

                    isCommand = true;
                }
                else if (body.toLowerCase() === "!reindex") {
    await sock.sendMessage(from, {
        text: "⏳ Knowledge base sedang dibangun ulang..."
    });

    await buildKnowledgeIndex();

    await sock.sendMessage(from, {
        text: `✅ Knowledge base selesai diindeks ulang. Total ${knowledgeIndex.length} chunk.`
    });

    isCommand = true;
}


                // Jika command, stop di sini.
                if (isCommand) return;

                // Jika bukan command, cek apakah ini chat ke diri sendiri atau ke orang lain.
                if (senderPhone === myPhone) {
                    return;
                }

                // Chat ke orang lain: trigger cooldown/handover.
                if (pendingMessages.has(from)) {
                    clearTimeout(pendingMessages.get(from).timerId);
                    pendingMessages.delete(from);
                }

                if (debounceTimers.has(from)) {
                    clearTimeout(debounceTimers.get(from));
                    debounceTimers.delete(from);
                }

                messageBatches.delete(from);
                botActiveUsers.delete(from);
                cooldownUsers.add(from);

                setTimeout(() => {
                    cooldownUsers.delete(from);
                    console.log(`✅ Cooldown 60 menit selesai untuk ${from}.`);
                }, 60 * 60 * 1000);

                console.log(
                    `✅ Alpeta mengambil alih ${from} (Phone: ${senderPhone}). Alfred nonaktif 60 menit.`
                );

                return;
            }

            // Cek cooldown untuk user biasa
            if (cooldownUsers.has(from)) {
                console.log(`⏳ ${from} dalam cooldown 60 menit. Pesan diabaikan.`);
                return;
            }

            // Anti-spam / message batching
            if (!messageBatches.has(from)) {
                messageBatches.set(from, []);
            }

            messageBatches.get(from).push(body);

            if (debounceTimers.has(from)) {
                clearTimeout(debounceTimers.get(from));
            }

            // Timer 5 menit awal
            if (!pendingMessages.has(from) && !botActiveUsers.has(from)) {
                const waitTimerId = setTimeout(() => {
                    pendingMessages.delete(from);

                    const batch = messageBatches.get(from) || [];
                    messageBatches.delete(from);

                    if (batch.length > 0) {
                        botActiveUsers.add(from);
                        processBatchReply(
                            sock,
                            from,
                            pushName,
                            batch.join("\n\n"),
                            true
                        );
                    }
                }, 5 * 60 * 1000);

                pendingMessages.set(from, { timerId: waitTimerId });
                console.log(
                    `⏱️ Timer 5 menit dimulai untuk ${from} (pushName: ${pushName}).`
                );
            }

            // Debounce timer 15 detik
            const debounceId = setTimeout(() => {
                if (pendingMessages.has(from)) return;

                const batch = messageBatches.get(from);
                messageBatches.delete(from);
                debounceTimers.delete(from);

                if (batch && batch.length > 0) {
                    const isFirstReply = !botActiveUsers.has(from);

                    if (isFirstReply) {
                        botActiveUsers.add(from);
                    }

                    processBatchReply(
                        sock,
                        from,
                        pushName,
                        batch.join("\n\n"),
                        isFirstReply
                    );
                }
            }, 15000);

            debounceTimers.set(from, debounceId);
        } catch (err) {
            console.error("❌ Error in messages.upsert:", err);
        }
    });

    process.on("uncaughtException", err => {
        console.error("❌ Uncaught Exception:", err);
    });

    process.on("unhandledRejection", (reason, promise) => {
        console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
    });
}

startAlfred().catch(error => {
    console.error("❌ Gagal menjalankan Alfred:", error);
    process.exit(1);
});
