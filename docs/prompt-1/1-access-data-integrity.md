# Perkuat akses, event/undo, dan isolasi database uji

> Run with: `$swarm` — perubahan lintas API, akses, transaksi PostgreSQL, dan test memerlukan implementasi serta review independen.

## Workspace

Kerjakan di git worktree, jangan di checkout utama.
- Repo: `/Volumes/dityath-workspace/Projects/Wooble`
- Branch: `prompt-1/1-access-data-integrity`
- Base: `4b5fa0a73baba300004da5caf661080c8750e4ab` (`main`/`origin/main` pada 13 Oktober 2026).
- Setup dari root repo, setelah memastikan branch/path belum ada:
  ```sh
  grep -qxF '.worktrees/' "$(git rev-parse --git-common-dir)/info/exclude" || echo '.worktrees/' >> "$(git rev-parse --git-common-dir)/info/exclude"
  git worktree add .worktrees/prompt-1-1 -b prompt-1/1-access-data-integrity 4b5fa0a73baba300004da5caf661080c8750e4ab
  cd .worktrees/prompt-1-1
  bun install --frozen-lockfile
  ```
- Jangan menimpa branch/path yang sudah ada; periksa dan lanjutkan hanya bila benar milik task ini.
- Gunakan konfigurasi test lokal dengan nilai fiktif. Jika `.env*` tidak terlacak perlu disalin dari root, pertahankan sebagai untracked, jangan cetak/commit isinya, dan jangan gunakan DB produksi/development pengguna untuk test. Semua perintah DB harus memakai URL disposable yang eksplisit.
- Prefix resource: `wooble_p1_1_`, nama DB memakai suffix acak per run; port bila diperlukan API `41411`, web `5176`. Pastikan belum terpakai, jangan hentikan proses lain.
- Setelah selesai commit per topik pada branch ini. Jangan merge ke main, push, atau hapus worktree.
- Jika memakai `$swarm`, gunakan branch/base/worktree ini sebagai workspace swarm; jangan membuat `swarm/<slug>` dari HEAD checkout utama.

## Goal

Selesaikan fondasi issue #10, #11, #12, dan #15 secara lokal dengan mempertahankan PR yang sudah ada. Hasil harus mencegah peer tanpa akses tetap menerima live data, lost updates akibat undo, event di luar transaksi, serta tabrakan database test antar-agent.

## Context

- Stack: Bun 1.3.14, TypeScript, Elysia, PostgreSQL/Drizzle, Zod, Biome, Turborepo.
- Repository/issue: `Dityath/Wooble`, https://github.com/Dityath/Wooble/issues/12; baca juga #10, #11, #15 dan `AGENTS.md`, `docs/ai-agents.md`.
- `apps/api/src/lib/auth.ts` — aturan workspace/canvas/object; PR #26 menambah `objectAccess` dan route classification.
- `apps/api/src/lib/live.ts` — join, revocation, peer lifecycle, immediate/periodic revalidation.
- `apps/api/src/modules/entity/routes.ts`, `modules/connection/routes.ts`, `modules/canvas/routes.ts` — PATCH/placement dan pencatatan event.
- `apps/api/src/modules/canvas/activity.ts`, `undo.ts` — data activity, locking dan restore metadata.
- `packages/db/src/schema/canvas-events.ts`, `packages/contracts/src`, `packages/domain/src` — storage dan kontrak bersama.
- `apps/api/tests/live-access.test.ts`, `object-access.test.ts`, `route-access.test.ts` — pola matrix test dari PR #26.
- `apps/api/tests/canvas-management.test.ts`, `canvas-undo.test.ts`, `support/client.ts` — pola route tests dan concurrency.
- `apps/api/tests/support/migrations.ts`, `migration-upgrade.test.ts`, `packages/db/tests/migrations.test.ts` — harness dari PR #28.
- `docs/testing.md`, `docs/architecture.md` — dokumentasi final yang perlu selaras.

PR yang sudah ditulis, jangan implementasikan ulang:

| PR | Issue | Head yang direview |
|---|---|---|
| #26 | #10 | `5ecc77a303a2e9c6a5d517b2540011ea445f4cbf` |
| #27 | #11 | `85124559303a142cb0f2d3fc42e8f79323ac5c8f` |
| #28 | #15 | `4f56d2460460edf015616d3911d8f27ea60f7962` |

Semua masih draft dengan CI sukses pada snapshot 13 Oktober, bukan bukti bahwa branch gabungan sudah lulus.

## Design

Sudah disetujui pengguna: jalur 1 dari empat jalur fondasi. Jangan brainstorm ulang pembagian kerja.
- Gunakan perubahan PR #26/#27/#28 sebagai baseline, tambah fix commit untuk temuan review, lalu implementasikan acceptance #12.
- Di worktree ini, fetch tiap PR ke ref lokal task yang unik, verifikasi head terhadap GitHub terkini, lalu merge lokal berurutan #26 → #27 → #28 tanpa rewrite. Contoh untuk #26:
  ```sh
  git fetch origin pull/26/head:refs/heads/prompt-1-source/pr-26
  git merge --no-ff --no-edit prompt-1-source/pr-26
  ```
  Gunakan `prompt-1-source/pr-27` dan `prompt-1-source/pr-28` untuk dua lainnya. Jika head berubah atau PR sudah merged, periksa diff terbaru dan ancestry; jangan mengambil asumsi review lama sebagai bukti baru.
- Event dan mutasi menjadi satu transaksi; undo hanya memulihkan key yang benar-benar diubah, dengan aturan legacy yang eksplisit.
- Scratch DB unik dan lifecycle berdasarkan ownership run. Ini wajib untuk empat agent paralel.
- Ditolak: menulis ulang seluruh auth, mengganti model hak akses multi-canvas tanpa keputusan produk, atau mengganti Markdown menjadi Yjs dalam task ini.

## Requirements

1. Reproduksi dan perbaiki temuan #26: immediate `revalidatePeers` menangkap error query tetapi meninggalkan peer joined. Jika akses tidak dapat dipastikan, close peer dengan 1011, keluarkan dari room/pending state sesuai lifecycle, dan tetap revalidate peer lain. Setelah revoke berhasil lalu satu recheck gagal, tidak boleh ada frame presence/cursor/activity berikutnya dari/ke peer tersebut. Test error ini berbeda dari test error saat `open()`.
2. Pertahankan prefix object route, default deny, route inventory, HEAD sebagai read, serta bentuk error 400/404. Uji manager, admin, editor, viewer, link guest, outsider, signed-out, revocation logout/password/member/admin.
3. Pertahankan #27: entity baru harus dapat dibaca actor sebelum placement, batch invalid tidak menulis apa pun, existing placement tidak berubah, dan query memakai transaction client tanpa pool acquisition tambahan. Pertahankan regression 12 request paralel. Jangan memperluas izin tulis atau menghapus akses source editor dengan perubahan aturan baru dalam task ini; laporkan masalah model tersebut untuk agent 4.
4. Perbaiki #28: hapus preemptive `DROP DATABASE` atas `<database>_upgrade`; buat nama acak bounded sesuai batas identifier PostgreSQL, create tanpa menghapus DB yang sudah ada, retry collision secara aman bila diperlukan, dan cleanup hanya nama yang berhasil dibuat run itu. Tutup koneksi sebelum cleanup. Test dua harness paralel dan preservation database sentinel yang sudah ada, seluruhnya di instance disposable.
5. Penuhi #12: entity, connection, dan canvas PATCH menyimpan event di transaksi yang sama dengan update. Canvas PATCH mengunci previous row. Pakai lock order konsisten dengan undo dan urutan event yang cocok dengan pemeriksaan undo; buktikan dengan deterministic interleaving test, bukan sleep yang berharap timing tertentu.
6. Undo update memulihkan hanya field dan metadata key yang diubah event. Bedakan key tidak ada, null, dan nilai; dokumentasikan perilaku event legacy yang menyimpan snapshot penuh. Test rename → documentation/contract/schema edit oleh pihak lain → undo rename tidak menghapus edit itu; test rollback jika insert event gagal.
7. Tambahkan registry undo kecil untuk action non-reversible, metadata key yang dikelola subsistem lain, serta snapshot/restore hook delete. Dokumentasikan antarmukanya agar kelak dipakai kolaborasi dan comment; jangan membuat subsistem itu sekarang.
8. `GET /api/canvases/:canvasId/activity` tidak mengirim previous/snapshot payload ke reader. Update kontrak/web consumer jika diperlukan tanpa menghilangkan data yang memang ditampilkan UI. Test viewer/link guest tidak memperoleh dokumentasi historis; undo server tetap memiliki data internal yang diperlukan.
9. Jalankan integration test terhadap PostgreSQL disposable dan review independen final diff termasuk security, transaction, migration dan test quality. Perbaiki temuan lalu verifikasi ulang bagian yang berubah.
10. Serahkan daftar commit per issue, exact SHA, hasil test, risiko integrasi, dan kontrak registry final kepada agent 3/4. Jangan mengubah GitHub; agent 4 pemilik tracking.

## Constraints / Out of scope

- Ada perubahan pengguna di checkout utama dan worktree `wooble-hardening`; jangan sentuh/stash/reset/commit perubahan itu.
- Agent lain bekerja paralel. Jangan revert perubahan mereka. Miliki perubahan API/event/undo/migration harness; koordinasikan overlap auth routes dengan agent 2, docs architecture dengan agent 4.
- Jangan menjalankan `apps/api/scripts/test-isolated.sh` dengan default shared database. Jangan mengubah migration rilis `0000`–`0005`. Bila schema change benar-benar diperlukan gunakan migration baru yang aman, jangan memaksa schema change hanya untuk registry.
- Biome tetap linter/formatter; tidak menurunkan coverage 90/90, mematikan Hooks/Fast Refresh, menambah ESLint/Prettier, atau melemahkan akses untuk meloloskan test.
- Tidak merge ke main atau branch integrasi bersama; merge lokal baseline ke branch task yang disebut dalam Design diperbolehkan. Tidak push, PR publication, deploy, atau remote issue edit.

## Acceptance criteria

- [ ] Temuan #26 dan #28 memiliki regression test yang gagal pada kode sebelum fix dan lulus sesudahnya.
- [ ] Acceptance issue #10/#11/#12/#15 terpetakan ke test atau batas bukti eksplisit.
- [ ] Undo tidak menimpa perubahan metadata yang tidak terkait; rollback event/mutasi dan concurrency terbukti dengan real PostgreSQL.
- [ ] DB uji yang bukan milik run tidak dihapus; dua run dapat berjalan tanpa saling memutus koneksi.
- [ ] Tidak ada previous/snapshot payload bocor lewat activity read.
- [ ] Review independen selesai; seluruh check relevan lulus pada SHA akhir, keterbatasan dilaporkan.
- [ ] Branch berisi commit final untuk dipakai sebagai satu-satunya parent agent 3; checkout pengguna tetap utuh.

## Verify

Provision database disposable unik terlebih dahulu. Set `DATABASE_URL` hanya di environment proses, jangan cetak atau menulis secret ke output. Role DB test membutuhkan CREATE DATABASE untuk harness; jangan beri hak ini pada user aplikasi produksi.

```sh
bun install --frozen-lockfile
bun run lint
bun run format:check
bun run typecheck
bun run build
bun run db:migrate
bun test apps/api/tests/*.test.ts
bun run test:web
bun test packages/*/tests
bun run coverage --enforce
git diff --check
git status --short
```

Catat setiap command/status dan DB run ID tanpa kredensial. Command coverage menjalankan suite lagi untuk agregasi; boleh memakai `--suite` dan `--merge-only --enforce` sesuai `docs/testing.md` agar tidak menggandakan run, selama raw output semuanya berasal dari SHA/run yang sama. Review diff dan staged files sebelum checkpoint commit.

## Assumptions

- Snapshot PR belum berubah saat task dimulai; wajib diverifikasi. Akses PostgreSQL/CREATE DATABASE mungkin perlu disiapkan, dan test yang belum berjalan harus ditulis sebagai belum terbukti.
