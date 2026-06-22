# 🎩 Alfred: WhatsApp AI Assistant (Local Edition)

Halo Alpeta Riza! Ini adalah paket kode Alfred yang sudah saya siapkan khusus untuk Anda jalankan di komputer atau laptop pribadi Anda. Dengan menjalankan secara lokal, Anda akan terhindar dari pemblokiran sistem keamanan WhatsApp yang ketat.

## 🚀 Persiapan Singkat
1. **Instal Node.js**: Unduh dan instal dari [nodejs.org](https://nodejs.org/).
2. **Ekstrak File**: Ekstrak file ZIP ini ke dalam sebuah folder di komputer Anda.

## 🛠️ Cara Menjalankan
1. Buka terminal atau Command Prompt (CMD) di dalam folder tersebut.
2. Jalankan perintah berikut untuk menginstal semua kebutuhan:
   ```bash
   npm install
   ```
3. Setelah selesai, jalankan Alfred dengan perintah:
   ```bash
   node index.js
   ```
4. Sebuah **Kode QR** akan muncul di terminal Anda.
5. Buka WhatsApp di ponsel > **Perangkat Tertaut** > **Tautkan Perangkat** > Pindai kode QR tersebut.

## 🎩 Fitur Alfred Anda:
- **Deteksi Kesibukan**: Menunggu 1 menit sebelum membalas pesan secara otomatis.
- **Perkenalan Khusus**: Memperkenalkan diri sebagai "Alfred asisten AI pribadi Alpeta".
- **Filter Grup**: Alfred hanya akan membalas chat pribadi dan mengabaikan grup.
- **AI Dinamis**: Menggunakan teknologi AI terbaru untuk memberikan balasan yang cerdas dan relevan.

**Catatan:** Jangan lupa untuk memasukkan `OPENAI_API_KEY` Anda di dalam file `.env` (jika Anda ingin menggunakan kunci API Anda sendiri) agar Alfred tetap bisa berpikir cerdas!

Selamat menggunakan Alfred! 🎩✨
