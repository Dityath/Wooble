# Fondasi Wooble menuju v0.5.0 — prompt set

Disetujui pengguna pada 13 Oktober 2026: empat jalur fondasi, empat agent/sesi, masing-masing memakai worktree. Ini batch lanjutan; menyelesaikannya belum berarti seluruh v0.2.0–v0.5.0 selesai.

Base integrasi: `main @ 4b5fa0a73baba300004da5caf661080c8750e4ab` (sama dengan `origin/main` saat pemeriksaan).
Checkout saat prompt ditulis: `feat/tiptap-documentation-editor @ 997c8224783dbe32009a0f982624cdd310f677f1`, dengan perubahan lokal canvas/connector yang belum di-commit. Snapshot commit editor hanya digunakan agent 2. Jangan membawa perubahan belum di-commit ke worktree mana pun.

| # | Prompt | Run with | Depends on | Branch |
|---|---|---|---|---|
| 1 | [Akses, integritas event/undo, dan isolasi migrasi](1-access-data-integrity.md) | `$swarm` | — | `prompt-1/1-access-data-integrity` |
| 2 | [Keamanan block editor dan browser CI](2-documentation-safety.md) | `$swarm` | — | `prompt-1/2-documentation-safety` |
| 3 | [Self-hosting dan jalur rilis](3-selfhosting-delivery.md) | `$swarm` | 1 | `prompt-1/3-selfhosting-delivery` |
| 4 | [ADR kolaborasi dan sinkronisasi roadmap GitHub](4-collaboration-roadmap.md) | `$swarm` | — | `prompt-1/4-collaboration-roadmap` |

## Run order

1. Agent 1, 2, dan 4 dapat mulai bersamaan. Mereka memakai base main yang dipatok di atas, bukan checkout editor aktif.
2. Agent 3 dapat membaca issue/PR sambil menunggu; mulai implementasi di worktree setelah agent 1 selesai dan menghasilkan commit. Base agent 3 adalah branch agent 1, termasuk perbaikannya.
3. Empat prompt berarti empat pemilik jalur. Setiap jalur tetap memerlukan review independen sesuai `AGENTS.md`; `$swarm` tidak boleh membuat worktree kedua dari HEAD checkout utama.
4. Setiap agent menyerahkan SHA akhir, checkpoint per issue/PR, hasil pemeriksaan, keterbatasan, dan konflik integrasi yang ditemukan. Agent 4 menyegarkan status GitHub setelah menerima hasil; commit lokal tidak berarti PR remote sudah diperbarui.

Jangan mengubah, stash, reset, commit, atau menghapus perubahan pengguna di checkout utama maupun worktree lain (`/Volumes/dityath-workspace/Projects/wooble-hardening` juga sudah ada). Tidak ada izin merge ke main, push, publish image, release tag, deploy, atau perubahan branch protection dalam prompt ini.

## Review snapshot dan pemetaan PR

Sumber: [PR terbuka](https://github.com/Dityath/Wooble/pulls), [issue](https://github.com/Dityath/Wooble/issues), [Project 1](https://github.com/users/Dityath/projects/1), diambil 13 Oktober 2026. Segarkan sebelum eksekusi.

| PR → issue | Head yang diperiksa | Penilaian sumber | Pemilik lanjutan |
|---|---|---|---|
| [#24](https://github.com/Dityath/Wooble/pull/24) → #17 | `c145c4a043354b29f4034cfdcaecf39ea00d73e3` | Sesuai scope backup exclusion; bukti isi image perlu dilengkapi | 3 |
| [#25](https://github.com/Dityath/Wooble/pull/25) → #13 | `63920de9f5c99106830625001cb8a260d1f07bcf` | Sesuai viewer/link-guest documentation; uji ulang bersama editor | 2 |
| [#26](https://github.com/Dityath/Wooble/pull/26) → #10 | `5ecc77a303a2e9c6a5d517b2540011ea445f4cbf` | Perlu perbaikan error immediate revalidation | 1 |
| [#27](https://github.com/Dityath/Wooble/pull/27) → #11 | `85124559303a142cb0f2d3fc42e8f79323ac5c8f` | Sesuai scope read access sebelum placement | 1 |
| [#28](https://github.com/Dityath/Wooble/pull/28) → #15 | `4f56d2460460edf015616d3911d8f27ea60f7962` | Perlu nama/ownership scratch DB aman untuk paralel | 1 |
| [#29](https://github.com/Dityath/Wooble/pull/29) → #14 | `365f454163708219f5d0f4c0d1bbe830c70571f2` | Sesuai browser CI; perlu menjalankan suite editor gabungan | 2 |
| [#30](https://github.com/Dityath/Wooble/pull/30) → #18 | `407902c22e964849385e5bd8b8fcad1af40e8bdb` | Perlu sanitasi diagnostic; base PR adalah branch #26 | 3 |
| [#31](https://github.com/Dityath/Wooble/pull/31) → #19 | `6673e2a414e944f00a3f9b6805ca2f507eb3430e` | Sesuai smoke #19; belum membuktikan seluruh #6 | 3 |

Seluruhnya masih draft, belum merged, dan check yang dilaporkan GitHub berhasil pada snapshot tersebut. Tidak ada formal review approval yang dikirim dalam audit ini. Review membaca diff, kode, test, acceptance issue, serta hasil CI; tidak menjalankan ulang lint/build/test/browser/database pada PR heads.

### Temuan yang harus ditangani

- **P1, #28:** [scratchDatabase](https://github.com/Dityath/Wooble/blob/4f56d2460460edf015616d3911d8f27ea60f7962/apps/api/tests/support/migrations.ts#L60) menjalankan `DROP DATABASE IF EXISTS ... WITH (FORCE)` atas nama deterministik `<db>_upgrade` sebelum membuat DB. Dua test run dapat menghapus DB satu sama lain. Buat nama unik, jangan preemptive drop, dan bersihkan hanya resource milik run tersebut.
- **P2, #26:** [revalidatePeers](https://github.com/Dityath/Wooble/blob/5ecc77a303a2e9c6a5d517b2540011ea445f4cbf/apps/api/src/lib/live.ts#L119-L123) hanya mencatat error query. Peer yang sudah dicabut aksesnya tetap berada dalam room sampai interval berikutnya. Tutup peer terkait secara fail-closed dengan kode reconnect yang sesuai, tetap periksa peer lain, dan tambah regression test.
- **P2, #30:** [config diagnostics](https://github.com/Dityath/Wooble/blob/407902c22e964849385e5bd8b8fcad1af40e8bdb/apps/api/src/lib/config.ts#L47) mencetak raw `WEB_ORIGIN` yang ditolak, termasuk credential/query rahasia. Laporkan nama setting dan posisi entry tanpa raw value.
- **Batas #31:** smoke menguji `/health`, API, socket dan persistence menggunakan cookie header; tidak membuktikan HTML/assets maupun login melalui browser dengan aturan cookie sebenarnya. Jangan menutup umbrella #6 dari hasil smoke ini saja.
- **Keputusan akses lanjutan:** #27 sengaja mengizinkan pembaca entity menempatkannya pada canvas yang ia edit. Aturan write pada semua canvas dapat membuat editor canvas sumber kehilangan akses tulis. Ini bukan perubahan scope #11; catat sebagai keputusan produk/akses terpisah, jangan ubah diam-diam.

## Shared contracts

- Semantic entities/connections tetap milik workspace; canvas menyimpan placement. Documentation berada di `metadata.documentation` entity/connection, bukan salinan per canvas.
- `PATCH /api/entities/:entityId` dan `PATCH /api/connections/:connectionId` mempertahankan bentuk API yang ada. Documentation tetap Markdown, `trim().max(20000)`, selama batch ini. `contractBody` dan `schemaSql` tetap maksimum 100000 karakter.
- PR #26 menyediakan `objectAccess(actor, kind, id, mode)`, klasifikasi registered route dan default deny. Jalur baru tidak boleh mengandalkan role dari client. Hak manager/admin, editor, viewer, link guest, outsider dan signed-out harus diuji.
- Agent 1 memiliki integritas transaksi, registry undo, dan lifecycle scratch DB. Agent 2 tidak mengubah persistence menjadi Yjs. Agent 3 mempertahankan perbaikan akses/undo dari base agent 1. Agent 4 menghasilkan ADR dan backlog, tanpa menambah dependency/runtime collaboration.
- Hasil spike ADR bukan izin mengganti format persistence. Implementasi kolaborasi v0.2.0, kontrak v0.3.0, schema v0.4.0, serta komentar v0.5.0 masuk backlog berikutnya.
- Gunakan database, port, dan Compose project unik per agent dan per run. Jangan memanggil script isolated lama dengan default nama DB yang dapat dipakai agent lain. Jangan mencetak URL/kredensial test maupun produksi.
- Pemilik perubahan GitHub hanya agent 4. Agent lain melaporkan hasil lokal; tidak menutup issue, mengganti label, atau mengedit PR secara bersamaan.

## Sinkronisasi pelacakan yang diharapkan

Issue yang punya PR tetap terbuka sampai diterima/merged. Label `status:ready` perlu dicocokkan dengan pekerjaan aktif (`status:claimed` tanpa mengarang assignee), dan issue diberi tautan PR yang tepat. Project tetap memakai kartu rilis sebagai ringkasan; tambahkan pemetaan issue/PR ke body kartu, bukan mengganti seluruh acceptance dengan daftar PR.

Kartu v0.2.0 dapat mencatat `In Progress` setelah verifikasi aktivitasnya. Kartu v0.3.0–v0.5.0 tidak menjadi `In Progress` hanya karena shared prerequisites sedang dikerjakan. Semua kartu belum memenuhi `Done`. Target v0.2.0 10 Oktober sudah lewat; tandai sebagai target awal yang perlu revisi, jangan mengarang tanggal baru.

PR #30 menuliskan `Closes #18`, tetapi `closingIssuesReferences` kosong pada snapshot karena base-nya bukan default branch. Verifikasi kembali hubungan tersebut setelah retarget ke main; jangan menyimpulkan #18 otomatis tertutup sekarang.

## Merge order

Hanya ketika maintainer kemudian mengizinkan integrasi: 1 → 2 → 3 → 4 ke `main`, dengan review/CI gabungan pada tiap langkah. Jalur 3 harus sesudah parent 1. Jangan menggabungkan branch atau menutup PR sekarang hanya karena prompt selesai.

Branch kerja di prompt ini membawa PR terdahulu melalui merge lokal agar provenance tetap utuh; jangan menerbitkan ulang perubahan yang sudah masuk main. Saat menyiapkan delivery nanti, cek mana PR asli yang sudah merged dan pisahkan commit follow-up yang masih dibutuhkan.

Jika parent 1 di-squash, child 3 perlu dipindahkan ke base baru sebelum integrasi: `git rebase --onto main prompt-1/1-access-data-integrity prompt-1/3-selfhosting-delivery`. Lakukan hanya pada branch lokal yang belum dibagikan atau dengan izin rewrite yang sesuai, setelah memeriksa commit graph dan perubahan main terbaru.

Overlap yang perlu diselesaikan secara sadar: `docs/testing.md` (1/2), `docs/architecture.md` (1/4), auth routes (1/2), README/CONTRIBUTING (beberapa jalur), serta `canvas-page.tsx` (editor dan PR #25). `MarkdownContent` saat ini masih dire-export oleh `rich-documentation.tsx`; perpindahan file tidak otomatis berarti import #25 rusak.
