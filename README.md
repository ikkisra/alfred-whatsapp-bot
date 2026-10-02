# Alfred WhatsApp Assistant

Alfred adalah asisten WhatsApp berbasis Node.js yang menggunakan [Baileys](https://github.com/WhiskeySockets/Baileys) untuk koneksi WhatsApp dan API yang kompatibel dengan format OpenAI untuk menghasilkan balasan AI.

Bot ini memiliki fitur:

- Balasan otomatis berbasis AI
- Dukungan OpenRouter atau endpoint API kompatibel OpenAI lainnya
- Pairing WhatsApp menggunakan QR code
- Penyimpanan session WhatsApp secara persisten
- Penyimpanan riwayat percakapan
- Penggabungan beberapa pesan dalam satu balasan
- Cooldown/handover ketika pemilik akun mulai mengambil alih percakapan
- Blacklist nomor
- Perintah rangkuman percakapan

> **Catatan:** Jangan membagikan API key, QR code, file session, atau isi log pairing ke publik.

## Prasyarat

- Node.js 18 atau lebih baru
- npm
- Docker dan Docker Compose jika menjalankan melalui container/Portainer
- Akun WhatsApp yang dapat digunakan untuk perangkat tertaut
- API key dari OpenRouter atau provider API kompatibel OpenAI

## Instalasi Lokal

Clone repository dan install dependency:

```bash
git clone URL_REPOSITORY_KAMU.git
cd NAMA_FOLDER_REPOSITORY
npm install
```

Buat file `.env` di root project:

```env
NINEROUTER_URL=https://openrouter.ai/api/v1
NINEROUTER_KEY=sk-or-v1-xxxxxxxxxxxxxxxx
AI_MODEL=openai/gpt-4o-mini
ALPETA_NUMBER=628xxxxxxxxxx
```

Keterangan:

| Variable | Keterangan |
|---|---|
| `NINEROUTER_URL` | Base URL API kompatibel OpenAI. Untuk OpenRouter gunakan `https://openrouter.ai/api/v1`. |
| `NINEROUTER_KEY` | API key provider AI. |
| `AI_MODEL` | ID model yang tersedia pada provider. |
| `ALPETA_NUMBER` | Nomor pemilik WhatsApp dalam format internasional tanpa tanda `+`. |

Jalankan bot:

```bash
node index.js
```

Jika QR code muncul di terminal, buka WhatsApp pada ponsel:

```text
WhatsApp → Perangkat tertaut → Tautkan perangkat
```

Scan QR code yang ditampilkan oleh aplikasi.

## Menjalankan dengan Docker Compose

Contoh `docker-compose.yml`:

```yaml
version: "3.8"

services:
  alfred-bot:
    build: .
    container_name: alfred-bot
    restart: unless-stopped
    environment:
      NINEROUTER_URL: ${NINEROUTER_URL}
      NINEROUTER_KEY: ${NINEROUTER_KEY}
      AI_MODEL: ${AI_MODEL}
      ALPETA_NUMBER: ${ALPETA_NUMBER}
    volumes:
      - alfred_session:/app/alfred_session
      - chat_history:/app/chat_history

volumes:
  alfred_session:
  chat_history:
```

Buat file `.env` pada lokasi yang sama dengan `docker-compose.yml`:

```env
NINEROUTER_URL=https://openrouter.ai/api/v1
NINEROUTER_KEY=sk-or-v1-xxxxxxxxxxxxxxxx
AI_MODEL=openai/gpt-4o-mini
ALPETA_NUMBER=628xxxxxxxxxx
```

Build dan jalankan:

```bash
docker compose build --no-cache
docker compose up -d
```

Lihat log:

```bash
docker logs -f alfred-bot
```

## Deploy di Portainer

1. Buka **Stacks** di Portainer.
2. Buat stack baru atau update stack yang sudah ada.
3. Masukkan isi `docker-compose.yml`.
4. Masukkan environment variables berikut pada bagian **Environment variables**:
   - `NINEROUTER_URL`
   - `NINEROUTER_KEY`
   - `AI_MODEL`
   - `ALPETA_NUMBER`
5. Deploy stack.
6. Buka log container `alfred-bot`.
7. Scan QR code jika diminta.

Pastikan nama environment variable sama persis dengan yang digunakan kode. Kode menggunakan `NINEROUTER_KEY`, bukan `OPENROUTER_API_KEY`.

## Persistensi Session WhatsApp

Konfigurasi berikut sangat penting:

```yaml
volumes:
  - alfred_session:/app/alfred_session
```

`alfred_session` adalah **named volume Docker**. Di dalamnya tersimpan kredensial perangkat tertaut WhatsApp.

Dengan volume tersebut, update atau recreate container tidak seharusnya meminta scan QR ulang selama volume tidak dihapus.

### Jangan lakukan ini saat hanya update script

```bash
docker compose down -v
```

Opsi `-v` akan menghapus named volume, termasuk session WhatsApp.

Jangan menghapus volume berikut kecuali memang ingin pairing ulang:

```text
alfred_session
```

Volume `chat_history` menyimpan riwayat percakapan dan juga sebaiknya tidak dihapus jika data masih diperlukan.

### Reset pairing WhatsApp

Jika session benar-benar invalid dan ingin pairing ulang:

```bash
docker compose down
docker volume ls | grep alfred
docker volume rm NAMA_VOLUME_SESSION
docker compose up -d
```

Nama volume sebenarnya dapat memiliki prefix nama project, misalnya:

```text
nama-project_alfred_session
```

Hapus hanya volume session. Jangan menghapus `chat_history` jika riwayat percakapan ingin dipertahankan.

## Update Script dengan Aman

Setelah mengubah `index.js`, jalankan:

```bash
docker compose build
docker compose up -d
```

Jika ingin memastikan seluruh dependency di-build ulang:

```bash
docker compose build --no-cache
docker compose up -d
```

Update fitur biasanya aman dilakukan tanpa scan QR ulang selama:

- Volume `alfred_session` tetap sama
- Mount path tetap `/app/alfred_session`
- Named volume tidak dihapus
- Tidak ada container Alfred lain yang menggunakan akun WhatsApp yang sama

## Perintah Bot

Perintah berikut dijalankan dari akun pemilik (`ALPETA_NUMBER`):

### Rangkuman percakapan

```text
!rangkum nomor
```

Contoh:

```text
!rangkum 628123456789
```

Bisa juga berdasarkan nama kontak:

```text
!rangkum Budi
```

### Blacklist

Tambah nomor:

```text
!blacklist add 628123456789
```

Hapus dari blacklist:

```text
!blacklist remove 628123456789
```

Lihat daftar blacklist:

```text
!blacklist list
```

Alias `!block` juga tersedia.

### Hapus riwayat dan cooldown

```text
!clear
```

Perintah ini menghapus riwayat percakapan untuk chat saat ini dan mereset state terkait.

### Daftar kontak

```text
!list
```

## Alur Cooldown dan Handover

Ketika pemilik akun mengirim pesan ke orang lain, Alfred menganggap pemilik sedang mengambil alih percakapan tersebut. Bot kemudian nonaktif untuk chat itu selama 60 menit.

Pesan dari pengguna akan dikumpulkan dan diproses menggunakan mekanisme batching/debounce sebelum AI mengirim balasan.

## Troubleshooting

### `404 Not Found`

Biasanya base URL atau endpoint salah.

Gunakan base URL seperti:

```env
NINEROUTER_URL=https://openrouter.ai/api/v1
```

Jangan memasukkan `/chat/completions` ke dalam `NINEROUTER_URL`, karena SDK akan menambahkannya saat memanggil:

```js
openai.chat.completions.create(...)
```

### `401 Unauthorized` dari AI

Biasanya API key salah, tidak terbaca, atau nama environment variable tidak cocok.

Cek dari dalam container tanpa mencetak key:

```bash
docker exec alfred-bot node -e "console.log({key: Boolean(process.env.NINEROUTER_KEY), url: process.env.NINEROUTER_URL, model: process.env.AI_MODEL})"
```

### `408 Request Timeout`

Artinya request AI terlalu lama. Periksa:

- Koneksi internet container
- DNS server
- Firewall/VPS
- Beban provider AI
- Panjang riwayat/prompt
- Timeout SDK

Tes koneksi dari container:

```bash
docker exec -it alfred-bot sh
wget -S -O- --timeout=30 https://openrouter.ai/api/v1/models
```

### `405 Method Not Allowed` saat AI dipanggil

Pastikan base URL menunjuk ke API endpoint yang benar dan request tidak diarahkan ke URL tunnel/proxy yang salah.

### `401` atau `405` saat koneksi WhatsApp

Jika log berbentuk:

```text
Connection closed. Status code: 401
```

atau:

```text
Connection closed. Status code: 405
```

maka error tersebut berasal dari koneksi Baileys ke WhatsApp Web, bukan API AI. Periksa:

- Versi `@whiskeysockets/baileys`
- Koneksi outbound dari container
- Apakah ada dua container memakai akun yang sama
- Apakah session lama sudah invalid
- Apakah `alfred_session` terpasang sebagai volume yang benar

### `515 Stream Errored`

Status `515` dapat muncul sesaat setelah QR berhasil dipindai:

```text
Stream Errored (restart required)
```

Jika setelah reconnect muncul:

```text
opened connection to WA
✅ Alfred ONLINE
```

maka pairing berhasil dan tidak perlu tindakan tambahan.

### Mengecek volume

```bash
docker volume ls
docker volume inspect NAMA_VOLUME_SESSION
docker exec alfred-bot sh -c 'ls -la /app/alfred_session'
```

## Keamanan

Jangan commit file berikut ke repository:

```text
.env
alfred_session/
chat_history/
blacklist.json
```

Tambahkan ke `.gitignore`:

```gitignore
.env
alfred_session/
chat_history/
blacklist.json
node_modules/
```

Jika API key terlanjur masuk Git, segera revoke key tersebut dan buat key baru.

## Operasional

Cek container yang berjalan:

```bash
docker ps
```

Cek semua container Alfred:

```bash
docker ps -a | grep -i alfred
```

Restart normal:

```bash
docker restart alfred-bot
```

Melihat log terbaru:

```bash
docker logs --tail 200 alfred-bot
```

Untuk debug koneksi Baileys, sementara gunakan logger level `info` di `index.js`. Setelah sistem stabil, gunakan level `error` agar log lebih ringkas:

```js
logger: pino({ level: "error" })
```

## Lisensi

Tambahkan lisensi project sesuai kebutuhan sebelum repository dipublikasikan.
